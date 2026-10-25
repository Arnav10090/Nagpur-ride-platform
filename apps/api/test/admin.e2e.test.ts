import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { FakeProvider } from '../src/domain/payments/fakeProvider';
import { Db } from '../src/domain/ports';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { CONSOLE_CSP, mountAdminUi } from '../src/http/adminUi';
import { maskPhone } from '../src/http/mask';
import { closePool, getPool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, prov: FakeProvider, t = 9_500_000; const codes = new Map<string, string>(); const seen = new Set<string>(); let uiDir = '';
const STAFF = { support: '9000000021', ops: '9000000022', finance: '9000000023', root: '9000000024' };
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory'); prov = new FakeProvider({ secret: 'whsec_admin', now: () => t });
  uiDir = mkdtempSync(join(tmpdir(), 'console-')); mkdirSync(join(uiDir, 'assets')); writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>console</title><script type="module" src="/console/assets/app-1.js"></script>'); writeFileSync(join(uiDir, 'assets', 'app-1.js'), 'console.log(1)');
  app = await NestFactory.create(buildModule({ db, paymentProvider: prov, accessKey: 'admin-e2e', now: () => t, rateLimiters: noopRateLimiters(), sender: { async send(p, c) { codes.set(p, c); } },
    adminPhones: { ['+91' + STAFF.support]: 'SUPPORT', ['+91' + STAFF.ops]: 'OPS_ADMIN', ['+91' + STAFF.finance]: 'FINANCE_ADMIN', ['+91' + STAFF.root]: 'SUPER_ADMIN' } }), { logger: false, rawBody: true });
  app.useGlobalFilters(new ErrorFilter()); mountAdminUi(app, uiDir); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });

const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone); await request(http).post('/api/v1/auth/otp/request').send({ phone });
  return (await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201)).body.data.accessToken as string;
};
const api = (tok: string) => ({ get: (u: string) => request(http).get('/api/v1' + u).set('Authorization', 'Bearer ' + tok), post: (u: string, b: object = {}) => request(http).post('/api/v1' + u).set('Authorization', 'Bearer ' + tok).send(b) });
const idOf = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id;
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
const hook = (e: { rawBody: string; signature: string }) => request(http).post('/api/v1/webhooks/payments/fake').set('content-type', 'application/json').set('x-signature', e.signature).send(e.rawBody);

let staff: Record<keyof typeof STAFF, ReturnType<typeof api>>; let world: { rideId: string; fare: number; riderPhone: string; driverPhone: string; driverId: string; dTok: string };
beforeAll(async () => {
  staff = { support: api(await login(STAFF.support)), ops: api(await login(STAFF.ops)), finance: api(await login(STAFF.finance)), root: api(await login(STAFF.root)) };
  const dTok = await login('9870000001', 'DRIVER'), dr = api(dTok), rider = api(await login('9880000001'));
  await dr.post('/drivers/onboarding', { registration: 'MH31AD0001' }); await staff.ops.post(`/admin/drivers/${idOf(dTok)}/review`, { decision: 'APPROVED', reason: 'verified' });
  await dr.post('/drivers/me/availability', { online: true }); await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 1 });
  const q = (await rider.post('/fare-quotes', { pickup: A, destination: B })).body.data;
  const ride = (await rider.post('/rides', { fareQuoteId: q.id, paymentMethod: 'UPI', idempotencyKey: 'admin-world-1' })).body.data;
  await dr.post(`/ride-offers/${(await dr.get('/drivers/me/offers')).body.data[0].id}/accept`);
  for (const s of ['en-route', 'arrive', 'start', 'complete']) await dr.post(`/rides/${ride.id}/${s}`);
  const ref = new URL((await rider.get(`/rides/${ride.id}/payment`)).body.data.intent.upiUri).searchParams.get('tr')!;
  await hook(prov.settle(ref, 'SUCCEEDED'));
  world = { rideId: ride.id, fare: q.fare.totalMinor, riderPhone: '+919880000001', driverPhone: '+919870000001', driverId: idOf(dTok), dTok };
});

describe('role matrix', () => {
  type Row = [string, string, string[]]; // method, path, allowed roles
  const R = (id = world?.rideId) => id;
  it('every endpoint allows exactly the intended staff roles; nobody else, and nobody unauthenticated', async () => {
    const all = ['support', 'ops', 'finance', 'root'] as const; const rows: Row[] = [
      ['GET', '/admin/me', [...all]], ['GET', '/admin/summary', [...all]], ['GET', '/admin/drivers', ['support', 'ops', 'root']], ['GET', '/admin/rides', [...all]], ['GET', `/admin/rides/${R()}`, [...all]],
      ['POST', '/admin/drivers/x/review', ['ops', 'root']], ['POST', '/admin/drivers/x/suspend', ['ops', 'root']], ['POST', '/admin/users/x/reinstate', ['ops', 'root']],
      ['POST', `/admin/payments/${R()}/refund`, ['finance', 'root']], ['GET', '/admin/reconciliation/findings', ['finance', 'root']], ['POST', '/admin/reconciliation/run', ['finance', 'root']],
      ['POST', '/admin/reconciliation/findings/x/resolve', ['finance', 'root']], ['GET', '/admin/audit-logs', ['ops', 'finance', 'root']]];
    const rider = api(await login('9880000002')); const driver = api(world.dTok);
    for (const [m, path, allowed] of rows) {
      const call = (c: ReturnType<typeof api>) => (m === 'GET' ? c.get(path) : c.post(path, {}));
      for (const role of all) { const st = (await call(staff[role])).status; expect(allowed.includes(role) ? st !== 403 && st !== 401 : st === 403, `${m} ${path} as ${role} -> ${st}`).toBe(true); }
      expect((await call(rider)).status, `${m} ${path} as rider`).toBe(403); expect((await call(driver)).status, `${m} ${path} as driver`).toBe(403);
      const anon = m === 'GET' ? request(http).get('/api/v1' + path) : request(http).post('/api/v1' + path).send({}); expect((await anon).status, `${m} ${path} anonymous`).toBe(401);
    }
  });
  it('staff roles can only be obtained from the server allow-list, never by asking for them', async () => {
    await request(http).post('/api/v1/auth/otp/request').send({ phone: '9871111111' });
    await request(http).post('/api/v1/auth/otp/verify').send({ phone: '9871111111', code: codes.get('+919871111111'), role: 'SUPER_ADMIN' }).expect(400);
    expect((await staff.support.get('/admin/me')).body.data.role).toBe('SUPPORT');
  });
});

describe('PII and audit', () => {
  it('phone numbers are masked for support and finance, in full only for ops and super admin', async () => {
    expect(maskPhone('+919876543210')).toBe('+91 98•••••210');
    for (const [who, full] of [['support', false], ['finance', false], ['ops', true], ['root', true]] as const) {
      const row = (await staff[who].get(`/admin/rides?q=${world.riderPhone.slice(-6)}`)).body.data[0]; expect(row.riderPhone, who).toBe(full ? world.riderPhone : '+91 98•••••001');
      const detail = (await staff[who].get(`/admin/rides/${world.rideId}`)).body.data; expect(detail.driver.phone, who).toBe(full ? world.driverPhone : '+91 98•••••001');
    }
    const drivers = (await staff.support.get('/admin/drivers')).body.data; expect(JSON.stringify(drivers)).not.toContain('9870000001');
  });
  it('viewing a ride is itself audited with the viewer', async () => {
    const before = (await staff.root.get('/admin/audit-logs')).body.data.filter((a: any) => a.action === 'VIEW_RIDE').length;
    await staff.support.get(`/admin/rides/${world.rideId}`); const after = (await staff.root.get('/admin/audit-logs')).body.data.filter((a: any) => a.action === 'VIEW_RIDE');
    expect(after.length).toBe(before + 1); expect(after[0].targetId).toBe(world.rideId); expect(after[0].actorId).toBe(idOf((await login(STAFF.support))));
  });
});

describe('console data', () => {
  it('summary counts and driver list (filters, search)', async () => {
    const s = (await staff.ops.get('/admin/summary')).body.data; expect(s).toMatchObject({ pendingDrivers: expect.any(Number), onlineDrivers: expect.any(Number), activeRides: expect.any(Number) }); expect(s.openPayments).toBe(0);
    const d = (await staff.ops.get('/admin/drivers?verification=APPROVED')).body.data; expect(d[0]).toMatchObject({ registration: 'MH31AD0001', verification: 'APPROVED', accountStatus: 'ACTIVE', online: true });
    expect((await staff.ops.get('/admin/drivers?verification=PENDING')).body.data.some((x: any) => x.registration === 'MH31AD0001')).toBe(false);
    expect((await staff.ops.get('/admin/drivers?q=AD0001')).body.data).toHaveLength(1); await staff.ops.get('/admin/drivers?q=ab').expect(400);   // too-short search is refused
    await staff.ops.get('/admin/drivers?verification=NOPE').expect(400);
  });
  it('ride search by id prefix, phone suffix and status; wildcards are literal', async () => {
    expect((await staff.ops.get(`/admin/rides?q=${world.rideId.slice(0, 8)}`)).body.data.map((r: any) => r.id)).toContain(world.rideId);
    expect((await staff.ops.get('/admin/rides?status=COMPLETED')).body.data.some((r: any) => r.id === world.rideId)).toBe(true);
    expect((await staff.ops.get('/admin/rides?status=SEARCHING')).body.data.some((r: any) => r.id === world.rideId)).toBe(false);
    expect((await staff.ops.get('/admin/rides?q=%25%25%25')).body.data).toEqual([]);                   // "%%%" must not match everything
    expect((await staff.ops.get('/admin/rides?q=___')).body.data).toEqual([]);
    await staff.ops.get('/admin/rides?limit=5000').expect(400);
  });
  it('ride detail: timeline, payment, ledger that balances; unknown/malformed ids are clean 404s', async () => {
    const d = (await staff.finance.get(`/admin/rides/${world.rideId}`)).body.data;
    expect(d).toMatchObject({ status: 'COMPLETED', paymentMethod: 'UPI', finalFareMinor: world.fare, driver: { registration: 'MH31AD0001', category: 'AUTO' }, payment: { status: 'SUCCEEDED', amountMinor: world.fare, refundedMinor: 0, refunds: [] } });
    expect(d.timeline.map((e: any) => e.type)).toEqual(['STATE_SEARCHING', 'STATE_DRIVER_ASSIGNED', 'STATE_DRIVER_ARRIVING', 'STATE_DRIVER_ARRIVED', 'STATE_IN_PROGRESS', 'STATE_COMPLETED']);
    const dr = d.ledger.filter((l: any) => l.direction === 'DEBIT').reduce((a: number, l: any) => a + l.amountMinor, 0), cr = d.ledger.filter((l: any) => l.direction === 'CREDIT').reduce((a: number, l: any) => a + l.amountMinor, 0);
    expect(dr).toBe(world.fare); expect(cr).toBe(world.fare);
    await staff.finance.get('/admin/rides/not-a-uuid').expect(404); await staff.finance.get('/admin/rides/00000000-0000-4000-8000-000000000000').expect(404);
  });
  it('a refund shows up in the same detail view, with its ledger reversal', async () => {
    await staff.finance.post(`/admin/payments/${world.rideId}/refund`, { amountMinor: 1000, reason: 'detour complaint' }).expect(201);
    const d = (await staff.support.get(`/admin/rides/${world.rideId}`)).body.data;
    expect(d.payment).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 1000 }); expect(d.payment.refunds[0]).toMatchObject({ amountMinor: 1000, kind: 'CUSTOMER', status: 'SUCCEEDED', reason: 'detour complaint' });
    expect(d.ledger.some((l: any) => l.transactionId.startsWith('refund:') && l.account === 'provider_receivable' && l.direction === 'CREDIT' && l.amountMinor === 1000)).toBe(true);
  });
});

describe('findings, suspension and reinstatement', () => {
  it('a finding is resolved once, by finance, with a real note; the audit log records who and why', async () => {
    prov.injectOrphan(4242); t += 3 * 60_000; await staff.finance.post('/admin/reconciliation/run').expect(201);
    const f = (await staff.finance.get('/admin/reconciliation/findings')).body.data.find((x: any) => x.kind === 'ORPHAN_AT_PROVIDER' && x.status === 'OPEN'); expect(f).toBeTruthy();
    await staff.ops.post(`/admin/reconciliation/findings/${f.id}/resolve`, { note: 'checked with gateway' }).expect(403);
    await staff.finance.post(`/admin/reconciliation/findings/${f.id}/resolve`, { note: 'ok' }).expect(400);                        // note too short
    await staff.finance.post(`/admin/reconciliation/findings/${f.id}/resolve`, { note: 'Refunded manually via gateway dashboard' }).expect(201);
    await staff.finance.post(`/admin/reconciliation/findings/${f.id}/resolve`, { note: 'trying again' }).expect(409);                // exactly once
    const after = (await staff.finance.get('/admin/reconciliation/findings')).body.data.find((x: any) => x.id === f.id); expect(after).toMatchObject({ status: 'RESOLVED', resolvedNote: 'Refunded manually via gateway dashboard' }); expect(after.resolvedBy).toBeTruthy();
    expect((await staff.root.get('/admin/audit-logs')).body.data.some((a: any) => a.action === 'FINDING_RESOLVED' && a.targetId === f.id)).toBe(true);
    await staff.finance.post('/admin/reconciliation/findings/not-a-uuid/resolve', { note: 'valid note here' }).expect(409);
    expect((await staff.support.get('/admin/summary')).body.data.openFindings).toBeGreaterThanOrEqual(0);
  });
  it('suspend blocks sign-in and live access; reinstate restores sign-in (and nothing else); both need a reason and are audited', async () => {
    const uTok = await login('9872222222', 'DRIVER'); const uid = idOf(uTok); await api(uTok).post('/drivers/onboarding', { registration: 'MH31AD0002' });
    await staff.ops.post(`/admin/drivers/${uid}/suspend`, { reason: '' }).expect(400); await staff.ops.post(`/admin/drivers/${uid}/suspend`, { reason: 'rider complaint, under review' }).expect(201);
    await api(uTok).get('/drivers/me/status').expect(401);
    await staff.ops.post(`/admin/users/${uid}/reinstate`, { reason: 'x' }).expect(400); await staff.ops.post(`/admin/users/${uid}/reinstate`, { reason: 'complaint dismissed' }).expect(201);
    await staff.ops.post(`/admin/users/${uid}/reinstate`, { reason: 'again please' }).expect(409);                                  // not suspended any more
    const back = await login('9872222222', 'DRIVER'); expect((await api(back).get('/drivers/me/status')).body.data.online).toBe(false);
    const actions = (await staff.root.get('/admin/audit-logs')).body.data.filter((a: any) => a.targetId === uid).map((a: any) => a.action); expect(actions).toContain('SUSPEND'); expect(actions).toContain('REINSTATE');
  });
});

describe('static console hosting', () => {
  it('serves the app with strict security headers; assets are cacheable, the shell is not', async () => {
    const r = await request(http).get('/console/').expect(200); expect(r.headers['content-security-policy']).toBe(CONSOLE_CSP); expect(r.headers['x-frame-options']).toBe('DENY'); expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['cache-control']).toBe('no-store'); expect(CONSOLE_CSP).not.toMatch(/unsafe-inline|unsafe-eval/); expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    const a = await request(http).get('/console/assets/app-1.js').expect(200); expect(a.headers['cache-control']).toMatch(/immutable/); expect(a.headers['content-security-policy']).toBeTruthy();
    expect((await request(http).get('/console/rides/123')).text).toContain('<title>console</title>');   // client-side routes fall back to the shell
    await request(http).get('/console/assets/missing.js').expect(404);                                    // a missing file is a 404, never HTML
    expect((await request(http).get('/api/v1/admin/me')).headers['content-security-policy']).toBeUndefined(); // API responses are not given console headers
  });
});

describe.skipIf(!PG_URL)('admin database guards', () => {
  it('a resolved finding can never be reopened or edited, even from raw SQL; resolution needs a person and a note', async () => {
    const q = (s: string, p: unknown[] = []) => getPool().query(s, p); const e = async (p: Promise<unknown>) => p.then(() => 'OK', (x: any) => String(x.message));
    await q(`INSERT INTO "ReconciliationFinding"(kind,"providerRef",details) VALUES('TEST','ref-guard','{}')`);
    expect(await e(q(`UPDATE "ReconciliationFinding" SET status='RESOLVED' WHERE "providerRef"='ref-guard'`))).toMatch(/finding_resolution_complete/);              // no resolver/note
    await q(`UPDATE "ReconciliationFinding" SET status='RESOLVED',"resolvedBy"='u',"resolvedNote"='a real note',"resolvedAt"=now() WHERE "providerRef"='ref-guard'`);
    expect(await e(q(`UPDATE "ReconciliationFinding" SET status='OPEN',"resolvedBy"=NULL,"resolvedAt"=NULL WHERE "providerRef"='ref-guard'`))).toMatch(/cannot be reopened|finding_resolution/);
    expect(await e(q(`UPDATE "ReconciliationFinding" SET "resolvedNote"='rewritten history' WHERE "providerRef"='ref-guard'`))).toMatch(/cannot be reopened or edited/);
    expect(await e(q(`DELETE FROM "ReconciliationFinding"`))).toMatch(/append-only/);
  });
});
