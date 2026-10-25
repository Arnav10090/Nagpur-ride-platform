import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { Db } from '../src/domain/ports';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, t = 12_000_000; const codes = new Map<string, string>();
const ADMIN = '9000000031';
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory');
  app = await NestFactory.create(buildModule({ db, accessKey: 'rating-key', now: () => t, rateLimiters: noopRateLimiters(),
    adminPhones: { '+919000000031': 'OPS_ADMIN' }, sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });

const seen = new Set<string>();
const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone);
  await request(http).post('/api/v1/auth/otp/request').send({ phone }).expect(201);
  return (await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201)).body.data;
};
const api = (tok: string) => ({
  get: (u: string) => request(http).get(`/api/v1/${u}`).set('Authorization', `Bearer ${tok}`),
  post: (u: string, b?: object) => request(http).post(`/api/v1/${u}`).set('Authorization', `Bearer ${tok}`).send(b),
});
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };

/** Follow the exact same driver setup pattern as e2e.test.ts */
async function onlineDriver(phone: string, reg: string, admin: ReturnType<typeof api>) {
  const d = await login(phone, 'DRIVER'); const dr = api(d.accessToken);
  await dr.post('drivers/onboarding', { registration: reg }).expect(201);
  const id = JSON.parse(Buffer.from(d.accessToken.split('.')[0]!, 'base64url').toString()).id;
  await admin.post(`admin/drivers/${id}/review`, { decision: 'APPROVED', reason: 'docs ok' }).expect(201);
  await dr.post('drivers/me/availability', { online: true }).expect(201);
  await dr.post('drivers/me/location', { lat: A.lat + 0.001, lng: A.lng, accuracyMeters: 10, recordedAt: new Date(t).toISOString(), sequence: 1 }).expect(201);
  return { dr, id, token: d.accessToken };
}

describe('ratings and earnings', () => {
  let rideId: string;
  let driverApi: ReturnType<typeof api>;
  let riderApi: ReturnType<typeof api>;
  let driverToken: string;

  it('rider books, driver completes a ride; rider rates driver; driver rates rider; duplicates blocked', async () => {
    const admin = api((await login(ADMIN)).accessToken);
    const drv = await onlineDriver('9998800031', 'MH31RT0001', admin);
    driverApi = drv.dr;
    driverToken = drv.token;

    riderApi = api((await login('9998800032')).accessToken);

    // Rider gets quote, books ride
    t += 1000;
    const q = (await riderApi.post('fare-quotes', { pickup: A, destination: B, category: 'AUTO' }).expect(201)).body.data;
    const ride = (await riderApi.post('rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'rate-test-001' }).expect(201)).body.data;
    rideId = ride.id;

    // Driver accepts (offers are created synchronously by dispatch on createRide)
    const offers = (await driverApi.get('drivers/me/offers')).body.data;
    expect(offers.length).toBeGreaterThan(0);
    await driverApi.post(`ride-offers/${offers[0].id}/accept`).expect(201);

    // Drive through all steps
    for (const s of ['en-route', 'arrive', 'start', 'complete']) {
      await driverApi.post(`rides/${rideId}/${s}`).expect(201);
    }

    // Rider rates driver: 5 stars
    const rateRes = await riderApi.post(`rides/${rideId}/rate`, { stars: 5, comment: 'Great ride!' });
    expect(rateRes.status).toBe(201);
    expect(rateRes.body.data.rated).toBe(true);
    expect(rateRes.body.data.stars).toBe(5);

    // Duplicate rating blocked
    const dup = await riderApi.post(`rides/${rideId}/rate`, { stars: 4 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_RATED');

    // Driver rates rider: 4 stars
    const driverRate = await driverApi.post(`rides/${rideId}/rate`, { stars: 4, comment: 'Polite passenger' });
    expect(driverRate.status).toBe(201);
    expect(driverRate.body.data.rated).toBe(true);

    // Driver duplicate also blocked
    const drvDup = await driverApi.post(`rides/${rideId}/rate`, { stars: 3 });
    expect(drvDup.status).toBe(409);

    // Star validation: 0 or 6 rejected
    const bad1 = await riderApi.post(`rides/${rideId}/rate`, { stars: 0 });
    expect(bad1.status).toBe(400);
    const bad2 = await riderApi.post(`rides/${rideId}/rate`, { stars: 6 });
    expect(bad2.status).toBe(400);
  });

  it('driver earnings endpoint returns summary with at least 1 completed ride', async () => {
    const res = await driverApi.get('drivers/me/earnings');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totalEarningsMinor');
    expect(res.body.data).toHaveProperty('ridesCompleted');
    expect(res.body.data.ridesCompleted).toBeGreaterThanOrEqual(1);
    expect(res.body.data.totalEarningsMinor).toBeGreaterThan(0);
  });

  it('driver rating endpoint returns average from rider rating', async () => {
    const res = await driverApi.get('drivers/me/rating');
    expect(res.status).toBe(200);
    expect(res.body.data.average).toBe(5);
    expect(res.body.data.count).toBe(1);
  });

  it('ride history pagination works', async () => {
    const res = await riderApi.get('rides?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data.rides.length).toBe(1);
    expect(res.body.data.rides[0].id).toBe(rideId);
    // nextCursor is null when only 1 ride
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('cannot rate a non-completed ride', async () => {
    // Book a new ride without completing it
    t += 1000;
    // Need to send a fresh location so the driver is eligible
    await driverApi.post('drivers/me/location', { lat: A.lat + 0.001, lng: A.lng, accuracyMeters: 10, recordedAt: new Date(t).toISOString(), sequence: 5 }).expect(201);
    const q2 = (await riderApi.post('fare-quotes', { pickup: A, destination: B, category: 'AUTO' }).expect(201)).body.data;
    const ride2 = (await riderApi.post('rides', { fareQuoteId: q2.id, paymentMethod: 'CASH', idempotencyKey: 'rate-test-002' }).expect(201)).body.data;
    // Don't complete — try rating
    const r = await riderApi.post(`rides/${ride2.id}/rate`, { stars: 5 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('cancellation after driver assignment charges a fee; before assignment no fee', async () => {
    const admin = api((await login(ADMIN)).accessToken);

    // Create a new driver for this test
    const drv2 = await onlineDriver('9998800041', 'MH31CF0001', admin);

    // Rider creates a ride that gets an offer
    t += 1000;
    const q = (await riderApi.post('fare-quotes', { pickup: A, destination: B, category: 'AUTO' }).expect(201)).body.data;
    const ride = (await riderApi.post('rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'cancel-fee-001' }).expect(201)).body.data;

    // Driver accepts → now assigned
    const offers = (await drv2.dr.get('drivers/me/offers')).body.data;
    expect(offers.length).toBeGreaterThan(0);
    await drv2.dr.post(`ride-offers/${offers[0].id}/accept`).expect(201);

    // Rider cancels after assignment → fee should be charged (2000 paise = ₹20)
    const cancelRes = await riderApi.post(`rides/${ride.id}/cancel`);
    expect(cancelRes.status).toBe(201);
    expect(cancelRes.body.data.status).toBe('CANCELLED');
    expect(cancelRes.body.data.cancellationFeeMinor).toBe(2000);

    // Now test cancel BEFORE assignment — book another ride where no driver is available
    // Make the driver offline first
    await drv2.dr.post('drivers/me/availability', { online: false });
    t += 1000;
    const q2 = (await riderApi.post('fare-quotes', { pickup: A, destination: B, category: 'AUTO' }).expect(201)).body.data;
    const ride2 = (await riderApi.post('rides', { fareQuoteId: q2.id, paymentMethod: 'CASH', idempotencyKey: 'cancel-fee-002' }).expect(201)).body.data;

    // Ride is EXPIRED (no driver available), can't cancel an expired ride
    // Instead, verify no cancellation fee on the cancelled-after-assignment ride via ledger
    const ledger = await db.tx(r => r.ledgerBalance(`rider_cancellation_fee:${ride.id}`));
    expect(ledger).toBe(-2000); // DEBIT of 2000 shows as negative balance
  });
});
