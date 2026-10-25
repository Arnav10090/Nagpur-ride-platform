import { BaseController } from './base';
import { ApiError, userMessage } from './errors';
import { Connection, LiveEvent } from './realtime';
import { ClientConfig, Platform } from './platform';
import { LL, PaymentView, Quote, RideSummary, RideView, TERMINAL } from './types';
import { isOtp, newKey, parsePhone, Store } from './util';

export interface RiderState {
  auth: 'UNKNOWN' | 'LOGGED_OUT' | 'LOGGED_IN'; otpSentTo: string | null; quote: Quote | null; ride: RideView | null; payment: PaymentView | null;
  driverLocation: (LL & { at: number }) | null; history: RideSummary[]; busy: boolean; error: string | null; connection: Connection; bookingKey: string | null;
}
export type RiderPhase = 'HOME' | 'QUOTE' | 'SEARCHING' | 'DRIVER_COMING' | 'DRIVER_ARRIVED' | 'ON_TRIP' | 'PAY' | 'DONE' | 'ENDED';
const PAYMENT_OPEN = ['PENDING', 'REQUIRES_ACTION', 'FAILED', 'CANCELLED'];

export function riderPhase(s: Pick<RiderState, 'ride' | 'payment' | 'quote'>): RiderPhase {
  const r = s.ride; if (!r) return s.quote ? 'QUOTE' : 'HOME';
  switch (r.status) {
    case 'REQUESTED': case 'SEARCHING': return 'SEARCHING';
    case 'DRIVER_ASSIGNED': case 'DRIVER_ARRIVING': return 'DRIVER_COMING';
    case 'DRIVER_ARRIVED': return 'DRIVER_ARRIVED';
    case 'IN_PROGRESS': return 'ON_TRIP';
    case 'COMPLETED': return r.paymentMethod === 'UPI' && (!s.payment || PAYMENT_OPEN.includes(s.payment.status)) ? 'PAY' : 'DONE';
    default: return 'ENDED';
  }
}

export class RiderController extends BaseController<RiderState> {
  constructor(platform: Platform, cfg: ClientConfig) {
    super(platform, cfg, new Store<RiderState>({ auth: 'UNKNOWN', otpSentTo: null, quote: null, ride: null, payment: null, driverLocation: null, history: [], busy: false, error: null, connection: 'DISCONNECTED', bookingKey: null }));
  }
  protected reset() { this.store.set({ quote: null, ride: null, payment: null, driverLocation: null, history: [], bookingKey: null, otpSentTo: null }); }

  /** App launch: restore the session and resume an unfinished ride or an unpaid trip. */
  async start() {
    if (!(await this.api.hasSession())) return void this.store.set({ auth: 'LOGGED_OUT' });
    this.store.set({ auth: 'LOGGED_IN' }); this.startWork();
    await this.run(() => this.resume());
  }
  private async resume() {
    const list = await this.api.rides(); this.store.set({ history: list });
    const open = list.find(r => !TERMINAL.includes(r.status) || (r.status === 'COMPLETED' && r.paymentMethod === 'UPI' && !!r.paymentStatus && PAYMENT_OPEN.includes(r.paymentStatus)));
    if (open) await this.loadRide(open.id);
  }

  async requestOtp(raw: string) {
    return this.run(async () => {
      const phone = parsePhone(raw); if (!phone) throw new ApiError(400, 'INVALID_PHONE', '');
      await this.api.requestOtp(phone); this.store.set({ otpSentTo: phone });
    });
  }
  async verifyOtp(code: string) {
    const ok = await this.run(async () => {
      const phone = this.store.get().otpSentTo; if (!phone || !isOtp(code)) throw new ApiError(401, 'OTP_INVALID', '');
      await this.api.verifyOtp(phone, code, 'RIDER'); this.store.set({ auth: 'LOGGED_IN', otpSentTo: null }); this.startWork();
    });
    if (ok) await this.run(() => this.resume());
    return ok;
  }
  async logout() { this.stopWork(); await this.api.logout(); this.reset(); this.store.set({ auth: 'LOGGED_OUT', error: null }); }
  changeNumber() { this.store.set({ otpSentTo: null, error: null }); }

  getQuote(pickup: LL, destination: LL) {
    return this.run(async () => { this.store.set({ quote: await this.api.quote(pickup, destination), bookingKey: null }); });
  }
  clearQuote() { this.store.set({ quote: null, bookingKey: null, error: null }); }

  /** The idempotency key is created once per quote and reused on every retry, so a dropped connection can never create two rides. */
  book(method: 'CASH' | 'UPI') {
    return this.run(async () => {
      const q = this.store.get().quote; if (!q) return;
      const key = this.store.get().bookingKey ?? newKey(); this.store.set({ bookingKey: key });
      try {
        const ride = await this.api.book({ fareQuoteId: q.id, paymentMethod: method, idempotencyKey: key });
        this.store.set({ quote: null, bookingKey: null }); await this.loadRide(ride.id);
      } catch (e) { if (e instanceof ApiError && e.code === 'QUOTE_EXPIRED') this.store.set({ quote: null, bookingKey: null }); throw e; }
    });
  }
  cancel() { return this.run(async () => { const r = this.store.get().ride; if (r) { await this.api.cancel(r.id); await this.refreshRide(); } }); }

  async loadRide(id: string) { this.store.set({ ride: await this.api.ride(id), driverLocation: null }); await this.afterRide(); }
  /** Applies a fetched ride only if it is not OLDER than what we already show (out-of-order responses must not rewind the screen). */
  async refreshRide() {
    const cur = this.store.get().ride; if (!cur) return;
    const v = await this.api.ride(cur.id); const now = this.store.get().ride;
    if (!now || now.id !== v.id || v.stateVersion < now.stateVersion) return;
    this.store.set({ ride: v }); await this.afterRide();
  }
  private async afterRide() { const r = this.store.get().ride; if (r && (r.status === 'COMPLETED' || r.paymentMethod === 'UPI')) await this.refreshPayment(); }
  async refreshPayment() {
    const r = this.store.get().ride; if (!r) return;
    try { const p = await this.api.payment(r.id); if (this.store.get().ride?.id === r.id) this.store.set({ payment: p }); }
    catch (e) { if (e instanceof ApiError && e.code === 'NOT_FOUND') this.store.set({ payment: null }); else if (!(e instanceof ApiError && e.isNetwork)) throw e; }
  }
  /** Opens the user's UPI app with the server-issued intent; confirmation always comes from the server, never from the app returning. */
  payNow() {
    return this.run(async () => {
      const intent = this.store.get().payment?.intent; if (!intent) return;
      try { await this.platform.openUrl(intent.upiUri); } catch { throw new ApiError(0, 'NO_UPI_APP', 'No UPI app'); }
    });
  }
  retryPayment() { return this.run(async () => { const r = this.store.get().ride; if (r) { await this.api.retryPayment(r.id); await this.refreshPayment(); } }); }
  dismiss() { this.store.set({ ride: null, payment: null, driverLocation: null, quote: null, error: null }); void this.loadHistory(); }
  async loadHistory() { try { this.store.set({ history: await this.api.rides() }); } catch { /* shown next time */ } }

  protected async onEvent(e: LiveEvent) {
    const s = this.store.get(); const id = e.data?.rideId;
    if (!s.ride || id !== s.ride.id) return;
    if (e.type === 'driver.location') return void this.store.set({ driverLocation: { lat: e.data.lat, lng: e.data.lng, at: e.data.at } });
    if (e.type === 'ride.status.changed' || e.type === 'ride.assigned') await this.refreshRide();
    if (e.type === 'payment.status.changed') await this.refreshPayment();
  }
  protected async resync() { if (this.store.get().ride) { await this.refreshRide(); await this.refreshPayment(); } else await this.resume(); }
  protected async tick() {
    const s = this.store.get(); if (s.auth !== 'LOGGED_IN' || !s.ride) return;
    if (!TERMINAL.includes(s.ride.status)) await this.refreshRide(); else if (riderPhase(s) === 'PAY') await this.refreshPayment();
  }
  get errorText() { return this.store.get().error; }
}
export { userMessage };
