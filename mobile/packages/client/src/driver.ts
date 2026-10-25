import { BaseController } from './base';
import { ApiError } from './errors';
import { Connection, LiveEvent } from './realtime';
import { ClientConfig, LocationFix, Platform } from './platform';
import { OfferView, PaymentView, RideView } from './types';
import { isOtp, isRegistration, normalizeRegistration, parsePhone, Store } from './util';

export interface DriverState {
  auth: 'UNKNOWN' | 'LOGGED_OUT' | 'LOGGED_IN'; otpSentTo: string | null; verification: 'UNKNOWN' | 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  online: boolean; offers: OfferView[]; ride: RideView | null; completed: { ride: RideView; payment: PaymentView | null } | null;
  gps: 'OFF' | 'OK' | 'DENIED' | 'ERROR'; busy: boolean; error: string | null; connection: Connection; notice: string | null;
}
export type DriverPhase = 'LOADING' | 'LOGIN' | 'ONBOARDING' | 'PENDING_APPROVAL' | 'REJECTED' | 'OFFLINE' | 'ONLINE' | 'ACTIVE_RIDE' | 'SUMMARY';
export function driverPhase(s: DriverState): DriverPhase {
  if (s.auth === 'UNKNOWN') return 'LOADING'; if (s.auth === 'LOGGED_OUT') return 'LOGIN';
  switch (s.verification) { case 'UNKNOWN': return 'LOADING'; case 'NOT_SUBMITTED': return 'ONBOARDING'; case 'PENDING': return 'PENDING_APPROVAL'; case 'REJECTED': return 'REJECTED'; }
  if (s.ride) return 'ACTIVE_RIDE'; if (s.completed) return 'SUMMARY'; return s.online ? 'ONLINE' : 'OFFLINE';
}
const EPOCH = Date.UTC(2026, 0, 1);

export class DriverController extends BaseController<DriverState> {
  private stopGps?: () => void; private lastSeq = 0; private lastSent = 0; private sending = false;
  constructor(platform: Platform, cfg: ClientConfig, private minFixGapMs = 4000) {
    super(platform, cfg, new Store<DriverState>({ auth: 'UNKNOWN', otpSentTo: null, verification: 'UNKNOWN', online: false, offers: [], ride: null, completed: null, gps: 'OFF', busy: false, error: null, connection: 'DISCONNECTED', notice: null }));
  }
  protected reset() { this.stopGps?.(); this.stopGps = undefined; this.store.set({ verification: 'UNKNOWN', online: false, offers: [], ride: null, completed: null, gps: 'OFF', otpSentTo: null, notice: null }); }

  async start() {
    if (!(await this.api.hasSession())) return void this.store.set({ auth: 'LOGGED_OUT' });
    this.store.set({ auth: 'LOGGED_IN' }); this.startWork(); await this.run(() => this.resume());
  }
  /** After a kill/restart: status, any ride in progress, and (if the server still has us online) location sharing. */
  private async resume() {
    const st = await this.api.driverStatus(); this.store.set({ verification: st.verification, online: st.online });
    if (st.verification !== 'APPROVED') return;
    const ride = await this.api.activeRide(); this.store.set({ ride });
    if (st.online) { await this.beginGps(); await this.refreshOffers(); }
  }
  async requestOtp(raw: string) {
    return this.run(async () => { const phone = parsePhone(raw); if (!phone) throw new ApiError(400, 'INVALID_PHONE', ''); await this.api.requestOtp(phone); this.store.set({ otpSentTo: phone }); });
  }
  async verifyOtp(code: string) {
    const ok = await this.run(async () => {
      const phone = this.store.get().otpSentTo; if (!phone || !isOtp(code)) throw new ApiError(401, 'OTP_INVALID', '');
      await this.api.verifyOtp(phone, code, 'DRIVER'); this.store.set({ auth: 'LOGGED_IN', otpSentTo: null }); this.startWork();
    });
    if (ok) await this.run(() => this.resume()); return ok;
  }
  async logout() { if (this.store.get().online) await this.goOffline(); this.stopWork(); await this.api.logout(); this.reset(); this.store.set({ auth: 'LOGGED_OUT', error: null }); }
  changeNumber() { this.store.set({ otpSentTo: null, error: null }); }

  onboard(registration: string) {
    return this.run(async () => {
      if (!isRegistration(registration)) throw new ApiError(400, 'VALIDATION_ERROR', '');
      await this.api.onboard(normalizeRegistration(registration)); this.store.set({ verification: 'PENDING' });
    });
  }
  refreshStatus() { return this.run(async () => { const st = await this.api.driverStatus(); this.store.set({ verification: st.verification }); }); }

  // ----- availability & location -----
  goOnline() {
    return this.run(async () => {
      if (!(await this.platform.location.requestPermission())) { this.store.set({ gps: 'DENIED' }); throw new ApiError(403, 'FORBIDDEN', 'Location permission denied'); }
      await this.api.setOnline(true); this.store.set({ online: true }); await this.beginGps(); await this.refreshOffers();
    });
  }
  goOffline() {
    return this.run(async () => { this.stopGps?.(); this.stopGps = undefined; await this.api.setOnline(false); this.store.set({ online: false, offers: [], gps: 'OFF' }); });
  }
  private async beginGps() {
    this.stopGps?.();
    try {
      this.stopGps = await this.platform.location.watch(f => { void this.pushFix(f); }, () => this.store.set({ gps: 'ERROR' }));
      await this.pushFix(await this.platform.location.current(), true); this.store.set({ gps: 'OK' });
    } catch { this.store.set({ gps: 'ERROR' }); }
  }
  /** Sequence numbers must increase across app restarts, so they are derived from the (server-corrected) clock, not a counter. */
  private nextSeq() { this.lastSeq = Math.max(this.lastSeq + 1, Math.floor((this.api.now() - EPOCH) / 100)); return this.lastSeq; }
  async pushFix(f: LocationFix, force = false) {
    const t = this.api.now(); if (this.sending || (!force && t - this.lastSent < this.minFixGapMs)) return;
    this.sending = true; this.lastSent = t;
    try {
      const r = await this.api.sendLocation({ lat: f.lat, lng: f.lng, accuracyMeters: Math.min(5000, Math.max(0, f.accuracyMeters)), recordedAt: new Date(Math.min(f.at, t)).toISOString(), sequence: this.nextSeq() });
      this.store.set({ gps: r.accepted || r.reason === 'REJECTED_FIX' ? 'OK' : this.store.get().gps });
    } catch (e) { if (!(e instanceof ApiError && e.isNetwork)) this.store.set({ gps: 'ERROR' }); }
    finally { this.sending = false; }
  }

  // ----- offers & rides -----
  async refreshOffers() { const o = await this.api.offers(); this.store.set({ offers: o.filter(x => x.expiresAt > this.api.now()) }); }
  accept(offerId: string) {
    return this.run(async () => {
      try { await this.api.accept(offerId); }
      catch (e) { await this.refreshOffers().catch(() => undefined); throw e; }
      this.store.set({ offers: [], completed: null, notice: null }); this.store.set({ ride: await this.api.activeRide() });
    });
  }
  reject(offerId: string) { return this.run(async () => { await this.api.reject(offerId); await this.refreshOffers(); }); }
  advance(step: 'en-route' | 'arrive' | 'start' | 'complete') {
    return this.run(async () => {
      const r = this.store.get().ride; if (!r) return;
      await this.api.advance(r.id, step);
      if (step === 'complete') { const ride = await this.api.ride(r.id); this.store.set({ ride: null, completed: { ride, payment: null } }); await this.refreshPayment(); }
      else await this.refreshRide();
    });
  }
  async refreshRide() {
    const r = this.store.get().ride; if (!r) return;
    const v = await this.api.ride(r.id); const now = this.store.get().ride; if (!now || v.stateVersion < now.stateVersion) return;
    if (v.status === 'CANCELLED') return void this.store.set({ ride: null, notice: 'The rider cancelled this trip.' });
    this.store.set({ ride: v });
  }
  async refreshPayment() {
    const c = this.store.get().completed; if (!c) return;
    try { const p = await this.api.payment(c.ride.id); this.store.set({ completed: { ...c, payment: p } }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
  }
  dismissSummary() { this.store.set({ completed: null, notice: null }); }

  protected async onEvent(e: LiveEvent) {
    const s = this.store.get();
    if (e.type === 'ride.offer.created' || e.type === 'ride.offer.invalidated') return this.refreshOffers();
    if (e.type === 'ride.status.changed' && s.ride && e.data?.rideId === s.ride.id) return this.refreshRide();
    if (e.type === 'payment.status.changed' && s.completed && e.data?.rideId === s.completed.ride.id) return this.refreshPayment();
  }
  protected async resync() { await this.resume(); }
  protected async tick() {
    const s = this.store.get(); if (s.auth !== 'LOGGED_IN' || s.verification !== 'APPROVED') return;
    if (s.ride) await this.refreshRide(); else if (s.online) await this.refreshOffers();
    if (s.completed && s.completed.payment?.status !== 'SUCCEEDED') await this.refreshPayment();
    if (s.verification === 'APPROVED' && !s.online && !s.ride) return;
  }
  stop() { this.stopGps?.(); super.stop(); }
}
