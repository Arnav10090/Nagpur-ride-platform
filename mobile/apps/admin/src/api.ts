import { ApiClient, ApiError, Tokens, TokenStore, userMessage } from '@rides/client';
import type { AuditRow, DriverRow, Finding, RideDetail, RideRow, Role, Summary } from './types';

/** Staff tokens live in sessionStorage: gone when the tab closes, never shared across tabs, never written to disk by the page. */
export const sessionTokenStore = (key = 'console.session.v1'): TokenStore => ({
  async load() { try { const v = sessionStorage.getItem(key); return v ? (JSON.parse(v) as Tokens) : null; } catch { return null; } },
  async save(t) { try { t ? sessionStorage.setItem(key, JSON.stringify(t)) : sessionStorage.removeItem(key); } catch { /* ignore */ } },
});

const ADMIN_MESSAGES: Record<string, string> = {
  FORBIDDEN: 'You do not have permission to do that.', REFUND_EXCEEDS_PAYMENT: 'That is more than the rider paid (or more than is left to refund).',
  INVALID_TRANSITION: 'That is no longer possible. Refresh the page and check the current state.', VALIDATION_ERROR: 'Please check what you entered (reasons and notes need a few words).',
};
export const adminMessage = (e: unknown) => (e instanceof ApiError && ADMIN_MESSAGES[e.code]) || userMessage(e);

const qs = (o: Record<string, string | number | undefined>) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`); return p.length ? '?' + p.join('&') : ''; };

export class AdminApi {
  readonly client: ApiClient;
  private expired?: () => void;
  constructor(baseUrl: string, store: TokenStore, fetchImpl?: typeof fetch) { this.client = new ApiClient({ baseUrl, store, onSessionExpired: () => this.expired?.(), fetchImpl }); }
  /** The app registers what to do when the server ends the session (return to the sign-in screen). */
  onExpired(fn: () => void) { this.expired = fn; }
  hasSession() { return this.client.hasSession(); }
  requestOtp(phone: string) { return this.client.requestOtp(phone); }
  verifyOtp(phone: string, code: string) { return this.client.verifyOtp(phone, code, 'RIDER'); }   // staff roles come ONLY from the server allow-list
  logout() { return this.client.logout(); }
  me() { return this.client.call<{ id: string; role: Role }>('GET', '/admin/me'); }
  summary() { return this.client.call<Summary>('GET', '/admin/summary'); }
  drivers(f: { verification?: string; q?: string }) { return this.client.call<DriverRow[]>('GET', '/admin/drivers' + qs(f)); }
  review(userId: string, decision: 'APPROVED' | 'REJECTED', reason: string) { return this.client.call('POST', `/admin/drivers/${userId}/review`, { decision, reason }); }
  suspend(userId: string, reason: string) { return this.client.call('POST', `/admin/drivers/${userId}/suspend`, { reason }); }
  reinstate(userId: string, reason: string) { return this.client.call('POST', `/admin/users/${userId}/reinstate`, { reason }); }
  rides(f: { status?: string; q?: string }) { return this.client.call<RideRow[]>('GET', '/admin/rides' + qs(f)); }
  ride(id: string) { return this.client.call<RideDetail>('GET', `/admin/rides/${id}`); }
  refund(rideId: string, amountMinor: number, reason: string) { return this.client.call('POST', `/admin/payments/${rideId}/refund`, { amountMinor, reason }); }
  findings() { return this.client.call<Finding[]>('GET', '/admin/reconciliation/findings'); }
  runReconciliation() { return this.client.call<{ checked: number; repaired: number; findings: number }>('POST', '/admin/reconciliation/run'); }
  resolveFinding(id: string, note: string) { return this.client.call('POST', `/admin/reconciliation/findings/${id}/resolve`, { note }); }
  audit() { return this.client.call<AuditRow[]>('GET', '/admin/audit-logs'); }
}
