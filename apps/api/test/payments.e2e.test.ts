import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { FakeProvider } from '../src/domain/payments/fakeProvider';
import { PaymentService } from '../src/domain/payments/service';
import { Db } from '../src/domain/ports';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, prov: FakeProvider, t = 7_000_000; const codes = new Map<string, string>(); const seen = new Set<string>();
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory'); prov = new FakeProvider({ secret: 'whsec_e2e', now: () => t });
  app = await NestFactory.create(buildModule({ db, paymentProvider: prov, accessKey: 'pay-e2e', now: () => t, rateLimiters: noopRateLimiters(),
    adminPhones: { '+919000000007': 'OPS_ADMIN', '+919000000008': 'FINANCE_ADMIN' }, sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false, rawBody: true });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });

const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone);
  await request(http).post('/api/v1/auth/otp/request').send({ phone });
  return (await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201)).body.data.accessToken as string;
};
const api = (tok: string) => ({ get: (u: string) => request(http).get('/api/v1' + u).set('Authorization', 'Bearer ' + tok),
  post: (u: string, b: object = {}) => request(http).post('/api/v1' + u).set('Authorization', 'Bearer ' + tok).send(b) });
const webhook = (e: { rawBody: string; signature?: string }, name = 'fake') => request(http).post(`/api/v1/webhooks/payments/${name}`).set('content-type', 'application/json').set('x-signature', e.signature ?? '').send(e.rawBody);
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
const idOf = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id;
const refOf = (uri: string) => new URL(uri).searchParams.get('tr')!;

/** A fresh UPI (or cash) ride taken all the way to COMPLETED over HTTP. */
let n = 0;
async function completedRide(method: 'UPI' | 'CASH' = 'UPI') {
  n++; const ops = api(await login('9000000007')); const i = String(n).padStart(2, '0');
  const dTok = await login(`95000000${i}`, 'DRIVER'), rTok = await login(`96000000${i}`), dr = api(dTok), rider = api(rTok);
  await dr.post('/drivers/onboarding', { registration: `MH31PY00${i}` }).expect(201); await ops.post(`/admin/drivers/${idOf(dTok)}/review`, { decision: 'APPROVED', reason: 'verified docs' }).expect(201);
  await dr.post('/drivers/me/availability', { online: true }).expect(201);
  await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 1 }).expect(201);
  const q = (await rider.post('/fare-quotes', { pickup: A, destination: B }).expect(201)).body.data;
  const ride = (await rider.post('/rides', { fareQuoteId: q.id, paymentMethod: method, idempotencyKey: `pay-e2e-booking-${n}` }).expect(201)).body.data;
  const offer = (await dr.get('/drivers/me/offers')).body.data[0]; await dr.post(`/ride-offers/${offer.id}/accept`).expect(201);
  for (const s of ['en-route', 'arrive', 'start']) await dr.post(`/rides/${ride.id}/${s}`).expect(201);
  const done = (await dr.post(`/rides/${ride.id}/complete`).expect(201)).body.data;
  return { ride, done, dr, rider, rTok, dTok, fare: q.fare.totalMinor as number };
}

describe('UPI payments over HTTP', () => {
  it('completion of a UPI ride creates a payment awaiting the rider; the intent is visible to the rider only', async () => {
    const x = await completedRide(); expect(x.done.paymentStatus).toBe('REQUIRES_ACTION');
    const mine = (await x.rider.get(`/rides/${x.ride.id}/payment`).expect(200)).body.data;
    expect(mine).toMatchObject({ status: 'REQUIRES_ACTION', amountMinor: x.fare, currency: 'INR', attempt: 1 }); expect(mine.intent.upiUri).toContain(`am=${(x.fare / 100).toFixed(2)}`);
    expect((await x.dr.get(`/rides/${x.ride.id}/payment`).expect(200)).body.data.intent).toBeNull();           // driver never gets the payment intent
    await api(await login('9777777701')).get(`/rides/${x.ride.id}/payment`).expect(404);                         // stranger
    expect((await db.tx(r => r.ledgerTotals())).debit).toBe(0);                                                 // nothing is booked until the provider confirms
  });
  it('a cash ride has no payment record but books its ledger split immediately', async () => {
    const x = await completedRide('CASH'); expect(x.done.paymentStatus).toBe('CASH_DUE'); await x.rider.get(`/rides/${x.ride.id}/payment`).expect(404);
    expect(await db.tx(r => r.ledgerBalance(`driver_payable:${x.ride.id}`))).toBeGreaterThan(0);
  });

  it('AC-05/06 end to end: forged webhook rejected, genuine accepted once, replay is a harmless 200', async () => {
    const x = await completedRide(); const ref = refOf((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.intent.upiUri); const ev = prov.settle(ref, 'SUCCEEDED');
    const forged = await webhook({ rawBody: ev.rawBody, signature: new FakeProvider({ secret: 'attacker', now: () => t }).signature(ev.rawBody) });
    expect(forged.status).toBe(401); expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await webhook({ rawBody: ev.rawBody })).status).toBe(401);                                          // no signature
    expect((await webhook({ rawBody: ev.rawBody.replace(String(x.fare), '1'), signature: ev.signature })).status).toBe(401); // tampered
    expect((await webhook(ev, 'razorpay')).status).toBe(404);                                                   // wrong provider path
    expect((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.status).toBe('REQUIRES_ACTION');

    const ok = await webhook(ev); expect(ok.status).toBe(200); expect(ok.body.outcome).toBe('CAPTURED');
    const again = await webhook(ev); expect(again.status).toBe(200); expect(again.body.outcome).toBe('DUPLICATE');
    expect((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data).toMatchObject({ status: 'SUCCEEDED', intent: null });
    expect(await db.tx(r => r.ledgerBalance(`driver_payable:${x.ride.id}`))).toBe(x.fare - Math.floor((x.fare * 1500 * 2 + 10_000) / 20_000));
    const tot = await db.tx(r => r.ledgerTotals()); expect(tot.debit).toBe(tot.credit);
  });
  it('failed payment can be retried by its rider only, and not while an attempt is live', async () => {
    const x = await completedRide(); const ref1 = refOf((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.intent.upiUri);
    await x.rider.post(`/rides/${x.ride.id}/payment/retry`).expect(409);                                         // still live
    await webhook(prov.settle(ref1, 'FAILED')).expect(200); expect((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.status).toBe('FAILED');
    await api(await login('9777777702')).post(`/rides/${x.ride.id}/payment/retry`).expect(404);                  // another rider learns nothing about this ride
    const r2 = (await x.rider.post(`/rides/${x.ride.id}/payment/retry`).expect(201)).body.data; expect(r2).toMatchObject({ status: 'REQUIRES_ACTION', attempt: 2 });
    expect(refOf(r2.intent.upiUri)).not.toBe(ref1);
    await x.dr.post(`/rides/${x.ride.id}/payment/retry`).expect(403);                                            // wrong role: drivers cannot retry
  });

  it('refunds: only FINANCE_ADMIN/SUPER_ADMIN, capped at the amount paid, audited', async () => {
    const x = await completedRide(); const ref = refOf((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.intent.upiUri);
    const fin = api(await login('9000000008')), ops = api(await login('9000000007'));
    await fin.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: 100, reason: 'too early' }).expect(409);  // not captured yet
    await webhook(prov.settle(ref, 'SUCCEEDED')).expect(200);
    await x.rider.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: 100, reason: 'self service' }).expect(403);
    await ops.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: 100, reason: 'wrong role' }).expect(403);
    await fin.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: x.fare + 1, reason: 'too much' }).expect(409);
    await fin.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: 100, reason: '' }).expect(400);
    await fin.post(`/admin/payments/${x.ride.id}/refund`, { amountMinor: 1000, reason: 'driver detour' }).expect(201);
    const p = (await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data; expect(p).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: 1000 });
    expect((await ops.get('/admin/audit-logs')).body.data.some((a: any) => a.action === 'REFUND_REQUESTED' && a.reason === 'driver detour')).toBe(true);
    const tot = await db.tx(r => r.ledgerTotals()); expect(tot.debit).toBe(tot.credit);
  });

  it('reconciliation endpoint repairs a lost webhook and lists findings; ops staff cannot use it', async () => {
    const x = await completedRide(); const ref = refOf((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.intent.upiUri);
    prov.settle(ref, 'SUCCEEDED');                                                      // customer paid, webhook never arrived
    prov.injectOrphan(777);
    const fin = api(await login('9000000008')); t += 3 * 60_000;
    await api(await login('9000000007')).post('/admin/reconciliation/run').expect(403);
    const run = (await fin.post('/admin/reconciliation/run').expect(201)).body.data; expect(run.repaired).toBeGreaterThanOrEqual(1); expect(run.findings).toBeGreaterThanOrEqual(1);
    expect((await x.rider.get(`/rides/${x.ride.id}/payment`)).body.data.status).toBe('SUCCEEDED');
    expect((await fin.get('/admin/reconciliation/findings')).body.data.some((f: any) => f.kind === 'ORPHAN_AT_PROVIDER')).toBe(true);
  });
  it('the dev-tools route does not exist unless enabled', async () => { await request(http).post('/api/v1/dev/fake-pay/anything').send({}).expect(404); });
  it('payment events reach the rider through the outbox with no payment secrets in them', async () => {
    const ev = (await db.tx(r => r.listOutbox())).filter(e => e.type === 'payment.status.changed');
    expect(ev.length).toBeGreaterThan(0); for (const e of ev) { expect(JSON.stringify(e.payload)).not.toMatch(/upi:|whsec|intent/); expect(e.payload.riderId).toBeTruthy(); }
  });
});
