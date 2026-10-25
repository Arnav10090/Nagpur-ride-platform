import { ApiError } from './errors';
import { LL, OfferView, PaymentView, Quote, RideSummary, RideView, Tokens } from './types';
import { decodeJwtExp } from './util';

export interface TokenStore { load(): Promise<Tokens | null>; save(t: Tokens | null): Promise<void> }
export interface ApiOptions { baseUrl: string; store: TokenStore; fetchImpl?: typeof fetch; onSessionExpired?: () => void; timeoutMs?: number }

export class ApiClient {
  private tokens: Tokens | null | undefined; private refreshing?: Promise<void>; serverOffsetMs = 0;
  constructor(private o: ApiOptions) {}
  /** Server's idea of "now" (from the Date header), so countdowns are right even when the phone clock is wrong. */
  now() { return Date.now() + this.serverOffsetMs; }

  private async loadTokens() { if (this.tokens === undefined) this.tokens = await this.o.store.load(); return this.tokens; }
  async hasSession() { return !!(await this.loadTokens()); }

  /** A token that is valid for at least the next minute; refreshes first if it is about to expire (used for sockets). */
  async accessToken(): Promise<string | null> {
    const t = await this.loadTokens(); if (!t) return null;
    const exp = decodeJwtExp(t.accessToken);
    if (exp && exp - this.now() < 60_000) { try { await this.refresh(); } catch (e) { if (!(e instanceof ApiError) || !e.isNetwork) return null; } }
    return (await this.loadTokens())?.accessToken ?? null;
  }

  /** Single-flight: many parallel 401s trigger ONE refresh. Going offline never logs the user out; only the server saying "invalid" does. */
  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async doRefresh() {
    const t = await this.loadTokens(); if (!t) throw new ApiError(401, 'UNAUTHENTICATED', 'No session');
    try {
      const next = await this.raw<Tokens>('POST', '/auth/session/refresh', { refreshToken: t.refreshToken }, false);
      this.tokens = { accessToken: next.accessToken, refreshToken: next.refreshToken }; await this.o.store.save(this.tokens);
    } catch (e) {
      if (e instanceof ApiError && !e.isNetwork && (e.status === 401 || e.status === 403)) { await this.clear(); this.o.onSessionExpired?.(); }
      throw e;
    }
  }
  async clear() { this.tokens = null; await this.o.store.save(null); }

  private async raw<T>(method: string, path: string, body: unknown, auth: boolean): Promise<T> {
    const f = this.o.fetchImpl ?? fetch; const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) { const t = await this.loadTokens(); if (t) headers.authorization = 'Bearer ' + t.accessToken; }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined; const timer = ctl && setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 15_000);
    let res: Response;
    try { res = await f(this.o.baseUrl + '/api/v1' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl?.signal }); }
    catch { throw new ApiError(0, 'NETWORK', 'Network request failed', true); }
    finally { if (timer) clearTimeout(timer); }
    const date = res.headers.get('date'); if (date) { const s = Date.parse(date); if (!Number.isNaN(s)) this.serverOffsetMs = s - Date.now(); }
    const json: any = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'HTTP_' + res.status, json?.error?.message ?? 'Request failed', !!json?.error?.retryable || res.status >= 500);
    return json?.data as T;
  }

  /** Authenticated call; on a 401 refreshes once and retries once. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try { return await this.raw<T>(method, path, body, true); }
    catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code === 'UNAUTHENTICATED' && (await this.loadTokens())) { await this.refresh(); return this.raw<T>(method, path, body, true); }
      throw e;
    }
  }

  // ----- auth -----
  requestOtp(phone: string) { return this.raw<{ sent: boolean }>('POST', '/auth/otp/request', { phone }, false); }
  async verifyOtp(phone: string, code: string, role: 'RIDER' | 'DRIVER') {
    const t = await this.raw<Tokens>('POST', '/auth/otp/verify', { phone, code, role }, false);
    this.tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken }; await this.o.store.save(this.tokens);
  }
  async logout() { const t = await this.loadTokens(); if (t) await this.raw('POST', '/auth/session/logout', { refreshToken: t.refreshToken }, false).catch(() => undefined); await this.clear(); }

  // ----- rider -----
  quote(pickup: LL, destination: LL, category = 'AUTO') { return this.call<Quote>('POST', '/fare-quotes', { pickup, destination, category }); }
  book(x: { fareQuoteId: string; paymentMethod: 'CASH' | 'UPI'; idempotencyKey: string }) { return this.call<{ id: string }>('POST', '/rides', x); }
  rides() { return this.call<RideSummary[]>('GET', '/rides'); }
  ride(id: string) { return this.call<RideView>('GET', `/rides/${id}`); }
  cancel(id: string) { return this.call<unknown>('POST', `/rides/${id}/cancel`); }
  payment(id: string) { return this.call<PaymentView>('GET', `/rides/${id}/payment`); }
  retryPayment(id: string) { return this.call<unknown>('POST', `/rides/${id}/payment/retry`); }

  // ----- driver -----
  onboard(registration: string, category = 'AUTO') { return this.call<unknown>('POST', '/drivers/onboarding', { registration, category }); }
  driverStatus() { return this.call<{ verification: 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED'; online: boolean }>('GET', '/drivers/me/status'); }
  setOnline(online: boolean) { return this.call<unknown>('POST', '/drivers/me/availability', { online }); }
  sendLocation(x: LL & { accuracyMeters: number; recordedAt: string; sequence: number }) { return this.call<{ accepted: boolean; reason?: string }>('POST', '/drivers/me/location', x); }
  offers() { return this.call<OfferView[]>('GET', '/drivers/me/offers'); }
  accept(offerId: string) { return this.call<unknown>('POST', `/ride-offers/${offerId}/accept`); }
  reject(offerId: string) { return this.call<unknown>('POST', `/ride-offers/${offerId}/reject`); }
  activeRide() { return this.call<RideView | null>('GET', '/drivers/me/active-ride'); }
  advance(id: string, step: 'en-route' | 'arrive' | 'start' | 'complete') { return this.call<unknown>('POST', `/rides/${id}/${step}`); }
}
