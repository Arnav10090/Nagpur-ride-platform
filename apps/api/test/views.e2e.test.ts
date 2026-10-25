import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, t = 8_000_000; const codes = new Map<string, string>(); const seen = new Set<string>();
beforeAll(async () => {
  const db = await makeDb(PG_URL ? 'postgres' : 'memory');
  app = await NestFactory.create(buildModule({ db, accessKey: 'views', now: () => t, adminPhones: { '+919000000006': 'OPS_ADMIN' }, rateLimiters: noopRateLimiters(), sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); http = app.getHttpServer();
});
afterAll(async () => { await app.close(); await closePool(); });
const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone);
  await request(http).post('/api/v1/auth/otp/request').send({ phone });
  return (await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201)).body.data.accessToken as string;
};
const api = (tok: string) => ({ get: (u: string) => request(http).get('/api/v1' + u).set('Authorization', 'Bearer ' + tok), post: (u: string, b: object = {}) => request(http).post('/api/v1' + u).set('Authorization', 'Bearer ' + tok).send(b) });
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
const idOf = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id;

describe('ride views for the mobile apps', () => {
  it('rider and driver each see only what they need; resume endpoints work', async () => {
    const ops = api(await login('9000000006')); const dTok = await login('9810000001', 'DRIVER'), dr = api(dTok), rTok = await login('9820000001'), rider = api(rTok), other = api(await login('9820000002'));
    expect((await dr.get('/drivers/me/status')).body.data).toEqual({ verification: 'NOT_SUBMITTED', online: false });
    await dr.post('/drivers/onboarding', { registration: 'MH 31 AB 4321' }); await ops.post(`/admin/drivers/${idOf(dTok)}/review`, { decision: 'APPROVED', reason: 'verified' });
    await dr.post('/drivers/me/availability', { online: true }); await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 1 });
    expect((await dr.get('/drivers/me/status')).body.data).toEqual({ verification: 'APPROVED', online: true });
    expect((await dr.get('/drivers/me/active-ride')).body.data).toBeNull();

    const q = (await rider.post('/fare-quotes', { pickup: A, destination: B })).body.data;
    const ride = (await rider.post('/rides', { fareQuoteId: q.id, paymentMethod: 'UPI', idempotencyKey: 'views-booking-1' })).body.data;
    const before = (await rider.get(`/rides/${ride.id}`)).body.data;
    expect(before).toMatchObject({ status: 'SEARCHING', paymentMethod: 'UPI', pickup: A, destination: B, estimatedFareMinor: q.fare.totalMinor, finalFareMinor: null, vehicle: null });

    const offer = (await dr.get('/drivers/me/offers')).body.data[0]; await dr.post(`/ride-offers/${offer.id}/accept`).expect(201);
    expect((await rider.get(`/rides/${ride.id}`)).body.data.vehicle).toEqual({ category: 'AUTO', registration: 'MH31AB4321' });
    const driverView = (await dr.get('/drivers/me/active-ride')).body.data; expect(driverView).toMatchObject({ id: ride.id, status: 'DRIVER_ASSIGNED', pickup: A, destination: B, vehicle: null });
    expect(JSON.stringify(driverView)).not.toContain(idOf(rTok));                                  // nothing identifying the rider is sent to the driver
    await other.get(`/rides/${ride.id}`).expect(404);

    for (const s of ['en-route', 'arrive', 'start', 'complete']) await dr.post(`/rides/${ride.id}/${s}`).expect(201);
    expect((await dr.get('/drivers/me/active-ride')).body.data).toBeNull();                       // freed after completion
    const hist = (await rider.get('/rides')).body.data; expect(hist.rides[0]).toMatchObject({ id: ride.id, status: 'COMPLETED', paymentMethod: 'UPI', fareMinor: q.fare.totalMinor, paymentStatus: 'REQUIRES_ACTION' });
    expect((await other.get('/rides')).body.data.rides).toEqual([]);                                     // history is private
    expect((await rider.get(`/rides/${ride.id}`)).body.data.finalFareMinor).toBe(q.fare.totalMinor);
  });
});
