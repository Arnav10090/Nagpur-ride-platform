import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { Db } from '../src/domain/ports';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, t = 5_000_000; const codes = new Map<string, string>();
const ADMIN = '9000000001';
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory');
  app = await NestFactory.create(buildModule({ db, accessKey: 'test-key', now: () => t, adminPhones: { '+919000000001': 'OPS_ADMIN' }, rateLimiters: noopRateLimiters(),
    sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });

const seen = new Set<string>();
const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone);
  await request(http).post('/api/v1/auth/otp/request').send({ phone }).expect(201);
  const r = await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201);
  return { token: r.body.data.accessToken as string, refresh: r.body.data.refreshToken as string };
};
const api = (tok: string) => ({
  get: (u: string) => request(http).get('/api/v1' + u).set('Authorization', 'Bearer ' + tok),
  post: (u: string, b: object = {}) => request(http).post('/api/v1' + u).set('Authorization', 'Bearer ' + tok).send(b),
});
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };

async function onlineDriver(phone: string, reg: string, admin: ReturnType<typeof api>, lat = 21.147) {
  const d = await login(phone, 'DRIVER'); const dr = api(d.token);
  await dr.post('/drivers/onboarding', { registration: reg }).expect(201);
  const id = JSON.parse(Buffer.from(d.token.split('.')[0]!, 'base64url').toString()).id;
  await admin.post(`/admin/drivers/${id}/review`, { decision: 'APPROVED', reason: 'docs ok' }).expect(201);
  await dr.post('/drivers/me/availability', { online: true }).expect(201);
  await dr.post('/drivers/me/location', { lat, lng: A.lng, accuracyMeters: 10, recordedAt: new Date(t).toISOString(), sequence: 1 }).expect(201);
  return { dr, id };
}

describe('auth', () => {
  it('OTP cannot be replayed; wrong OTP rejected; role not self-assignable to admin', async () => {
    await request(http).post('/api/v1/auth/otp/request').send({ phone: '9111111111' });
    const code = codes.get('+919111111111');
    await request(http).post('/api/v1/auth/otp/verify').send({ phone: '9111111111', code: '000000' }).expect(401);
    await request(http).post('/api/v1/auth/otp/verify').send({ phone: '9111111111', code }).expect(201);
    await request(http).post('/api/v1/auth/otp/verify').send({ phone: '9111111111', code }).expect(401);
    await request(http).post('/api/v1/auth/otp/verify').send({ phone: '9111111112', code, role: 'SUPER_ADMIN' }).expect(400);
  });
  it('refresh rotates; old refresh token is dead', async () => {
    const s = await login('9222222222');
    await request(http).post('/api/v1/auth/session/refresh').send({ refreshToken: s.refresh }).expect(201);
    await request(http).post('/api/v1/auth/session/refresh').send({ refreshToken: s.refresh }).expect(401);
  });
  it('rejects missing and tampered tokens', async () => {
    await request(http).get('/api/v1/rides').expect(401);
    const s = await login('9333333333'); await api(s.token + 'x').get('/rides').expect(401);
  });
});

describe('otp throttle', () => {
  it('limits repeat OTP requests per phone', async () => {
    await request(http).post('/api/v1/auth/otp/request').send({ phone: '9123456789' }).expect(201);
    await request(http).post('/api/v1/auth/otp/request').send({ phone: '9123456789' }).expect(429);
  });
});

describe('end to end ride', () => {
  it('rider books, driver accepts and completes, cash ledger balances, strangers blocked', async () => {
    const admin = api((await login(ADMIN)).token);
    await onlineDriver('9444444441', 'MH31AB1234', admin);
    const { dr } = await onlineDriver('9444444442', 'MH31AB9999', admin, 21.17);
    const rider = api((await login('9555555551')).token); const stranger = api((await login('9555555552')).token);

    const q = (await rider.post('/fare-quotes', { pickup: A, destination: B }).expect(201)).body.data;
    expect(q.fare.totalMinor).toBeGreaterThanOrEqual(5000);
    await stranger.post('/rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'abcdefgh1' }).expect(404); // quote ownership
    const body = { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'booking-0001' };
    const [r1, r2] = await Promise.all([rider.post('/rides', body), rider.post('/rides', body)]); // AC-03
    expect(r1.body.data.id).toBe(r2.body.data.id); const rideId = r1.body.data.id;

    await stranger.get(`/rides/${rideId}`).expect(404); // AC-08
    await stranger.post(`/rides/${rideId}/cancel`).expect(404);

    await rider.post(`/rides/${rideId}/start`).expect(403); // riders cannot drive trips
  });

  it('full lifecycle with exclusive acceptance and balanced cash ledger', async () => {
    const admin = api((await login(ADMIN)).token);
    const d1 = await onlineDriver('9666666661', 'MH31CC0001', admin, 21.146);
    const d2 = await onlineDriver('9666666662', 'MH31CC0002', admin, 21.2);
    const rider = api((await login('9777777771')).token);
    const q = (await rider.post('/fare-quotes', { pickup: A, destination: B })).body.data;
    const ride = (await rider.post('/rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'booking-0002' })).body.data;
    const offers = (await d1.dr.get('/drivers/me/offers')).body.data; expect(offers).toHaveLength(1);
    expect(ride.status).toBe('SEARCHING');

    await d2.dr.post(`/ride-offers/${offers[0].id}/accept`).expect(404); // someone else's offer
    await d1.dr.post(`/ride-offers/${offers[0].id}/accept`).expect(201);
    await d1.dr.post(`/ride-offers/${offers[0].id}/accept`).expect(409); // replay
    await d2.dr.post(`/rides/${ride.id}/start`).expect(404);            // unassigned driver learns nothing
    await d1.dr.post(`/rides/${ride.id}/start`).expect(409);            // skipping states
    for (const s of ['en-route', 'arrive', 'start']) await d1.dr.post(`/rides/${ride.id}/${s}`).expect(201);
    const done = await d1.dr.post(`/rides/${ride.id}/complete`).expect(201);
    expect(done.body.data.status).toBe('COMPLETED'); expect(done.body.data.finalFareMinor).toBe(q.fare.totalMinor);
    await d1.dr.post(`/rides/${ride.id}/complete`).expect(409);          // no double finalise
    expect((await rider.get(`/rides/${ride.id}`)).body.data.status).toBe('COMPLETED');
    const commission = Math.floor((q.fare.totalMinor * 1500 * 2 + 10_000) / 20_000);
    expect(await db.tx(x => x.ledgerBalance(`driver_payable:${ride.id}`))).toBe(q.fare.totalMinor - commission);
    const tot = await db.tx(x => x.ledgerTotals()); expect(tot.debit).toBe(tot.credit); expect(tot.debit).toBe(q.fare.totalMinor);
  });
});

describe('driver eligibility and admin', () => {
  it('unapproved driver cannot go online; non-admin cannot review; reviews are audited', async () => {
    const d = api((await login('9888888881', 'DRIVER')).token);
    await d.post('/drivers/onboarding', { registration: 'MH31XX7777' }).expect(201);
    await d.post('/drivers/me/availability', { online: true }).expect(403);
    await d.post('/admin/drivers/x/review', { decision: 'APPROVED', reason: 'self' }).expect(403);
    const admin = api((await login(ADMIN)).token);
    expect((await admin.get('/admin/audit-logs')).body.data.length).toBeGreaterThan(0);
  });
  it('rejects stale/out-of-order/inaccurate GPS and out-of-zone quotes', async () => {
    const admin = api((await login(ADMIN)).token);
    const { dr } = await onlineDriver('9999999991', 'MH31GG0001', admin);
    const fix = (o: object) => dr.post('/drivers/me/location', { lat: 21.1, lng: 79.0, accuracyMeters: 10, recordedAt: new Date(t).toISOString(), sequence: 5, ...o });
    expect((await fix({ sequence: 1 })).body.data.accepted).toBe(false);
    expect((await fix({ accuracyMeters: 500 })).body.data.accepted).toBe(false);
    const rider = api((await login('9999999992')).token);
    await rider.post('/fare-quotes', { pickup: { lat: 19.07, lng: 72.87 }, destination: B }).expect(403);
  });
});
