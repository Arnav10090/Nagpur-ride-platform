import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FakeProvider } from '../../../../apps/api/src/domain/payments/fakeProvider';
import { OutboxWorker } from '../../../../apps/api/src/domain/outbox';
import { DispatchService } from '../../../../apps/api/src/domain/dispatch';
import { Store } from '../../../../apps/api/src/domain/memory';
import { buildModule, ErrorFilter } from '../../../../apps/api/src/http/app.module';
import { AuthService } from '../../../../apps/api/src/http/auth';
import { LiveHub } from '../../../../apps/api/src/http/realtime';
import { Platform, LocationFix, TokenStore, Tokens } from '../src';

export const SECRET = 'whsec_mobile_tests';
export async function startServer() {
  const db = new Store(); const codes = new Map<string, string>(); const hub = new LiveHub(); const provider = new FakeProvider({ secret: SECRET, now: Date.now });
  const app = await NestFactory.create(buildModule({ db, hub, paymentProvider: provider, accessKey: 'mobile-test-key', adminPhones: { '+919000000001': 'OPS_ADMIN', '+919000000002': 'SUPPORT', '+919000000003': 'FINANCE_ADMIN', '+919000000004': 'SUPER_ADMIN', '+919000000005': 'OPS_ADMIN' },
    sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false, rawBody: true });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); hub.attach(app.getHttpServer(), app.get(AuthService)); await app.listen(0);
  const baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const worker = new OutboxWorker(db, hub, Date.now); const dispatch = app.get(DispatchService);
  const timer = setInterval(() => { void worker.tick().catch(() => 0); void dispatch.sweep().catch(() => 0); }, 80);
  const post = async (path: string, token: string | null, body: object, headers: Record<string, string> = {}) => {
    const r = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  /** Staff action done outside the apps (an ops person approving a driver). */
  async function approve(driverUserId: string) {
    await post('/api/v1/auth/otp/request', null, { phone: '9000000001' }).catch(() => 0);
    const code = codes.get('+919000000001')!; const v = await post('/api/v1/auth/otp/verify', null, { phone: '9000000001', code });
    const tok = v.status === 201 ? v.body.data.accessToken : adminToken; adminToken = tok;
    const r = await post(`/api/v1/admin/drivers/${driverUserId}/review`, tok, { decision: 'APPROVED', reason: 'verified in test' }); if (r.status !== 201) throw new Error('approve failed ' + r.status);
  }
  let adminToken = '';
  const webhook = (e: { rawBody: string; signature: string }) => fetch(baseUrl + '/api/v1/webhooks/payments/fake', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': e.signature }, body: e.rawBody });
  /** Returns the shared world to "nothing in flight": no open rides, no live offers, no driver online. Call between tests. */
  const resetWorld = async () => {
    for (const r of db.rides.values()) if (!['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(r.status)) db.rides.set(r.id, { ...r, status: 'CANCELLED', stateVersion: r.stateVersion + 1 });
    for (const o of db.offers.values()) if (o.status === 'PENDING') o.status = 'INVALIDATED';
    for (const d of db.drivers.values()) db.drivers.set(d.id, { ...d, online: false, activeRideId: null });
    await new Promise(r => setTimeout(r, 200));                                    // let any in-flight worker tick drain
  };
  return { baseUrl, db, codes, provider, approve, resetWorld, webhook, post, otpFor: (p10: string) => codes.get('+91' + p10)!,
    stop: async () => { clearInterval(timer); await hub.close(); await app.close(); } };
}
export type TestServer = Awaited<ReturnType<typeof startServer>>;

export class MemoryTokenStore implements TokenStore { t: Tokens | null = null; async load() { return this.t; } async save(t: Tokens | null) { this.t = t; } }
export class FakeLocation {
  granted = true; fixes: ((f: LocationFix) => void)[] = []; position: LocationFix = { lat: 21.1465, lng: 79.0885, accuracyMeters: 8, at: Date.now() }; watching = 0;
  async requestPermission() { return this.granted; }
  async current() { return { ...this.position, at: Date.now() }; }
  async watch(cb: (f: LocationFix) => void) { this.watching++; this.fixes.push(cb); return () => { this.watching--; this.fixes = this.fixes.filter(x => x !== cb); }; }
  emit(p: Partial<LocationFix> = {}) { const f = { ...this.position, ...p, at: Date.now() }; this.fixes.forEach(cb => cb(f)); }
}
export function fakePlatform(store = new MemoryTokenStore(), location = new FakeLocation()) {
  const opened: string[] = []; let failOpen = false;
  const platform: Platform = { storage: store, location, openUrl: async (u: string) => { if (failOpen) throw new Error('no app'); opened.push(u); } };
  return { platform, store, location, opened, failOpen: (v: boolean) => { failOpen = v; } };
}
export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 6000, label = 'condition'): Promise<T> {
  const end = Date.now() + ms; let last: unknown;
  while (Date.now() < end) { try { const v = fn(); if (v) return v as T; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${label}` + (last ? ': ' + String(last) : ''));
}
export const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
export const idFromToken = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id as string;
