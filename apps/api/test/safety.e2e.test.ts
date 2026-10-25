import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { Db } from '../src/domain/ports';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, t = 70_000_000; const codes = new Map<string, string>();
const ADMIN = '9000000051';
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory');
  app = await NestFactory.create(buildModule({ db, accessKey: 'sos-key', now: () => t, rateLimiters: noopRateLimiters(),
    adminPhones: { '+919000000051': 'OPS_ADMIN' }, sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false });
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

async function onlineDriver(phone: string, reg: string, admin: ReturnType<typeof api>) {
  const d = await login(phone, 'DRIVER'); const dr = api(d.accessToken);
  await dr.post('drivers/onboarding', { registration: reg }).expect(201);
  const id = JSON.parse(Buffer.from(d.accessToken.split('.')[0]!, 'base64url').toString()).id;
  await admin.post(`admin/drivers/${id}/review`, { decision: 'APPROVED', reason: 'docs ok' }).expect(201);
  await dr.post('drivers/me/availability', { online: true }).expect(201);
  await dr.post('drivers/me/location', { lat: A.lat + 0.001, lng: A.lng, accuracyMeters: 10, recordedAt: new Date(t).toISOString(), sequence: 1 }).expect(201);
  return { dr, id, token: d.accessToken };
}

describe('SOS safety system', () => {
  it('rider triggers SOS on active ride; admin lists and resolves; SOS on completed ride rejected', async () => {
    const admin = api((await login(ADMIN)).accessToken);
    const drv = await onlineDriver('9997700051', 'MH31SOS001', admin);

    const riderTok = (await login('9997700052')).accessToken;
    const rider = api(riderTok);

    // Book and get to DRIVER_ASSIGNED
    t += 1000;
    const q = (await rider.post('fare-quotes', { pickup: A, destination: B, category: 'AUTO' }).expect(201)).body.data;
    const ride = (await rider.post('rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'sos-test-001' }).expect(201)).body.data;

    const offers = (await drv.dr.get('drivers/me/offers')).body.data;
    await drv.dr.post(`ride-offers/${offers[0].id}/accept`).expect(201);

    // Rider triggers SOS
    const sosRes = await rider.post(`rides/${ride.id}/sos`, { description: 'I feel unsafe', lat: 21.145, lng: 79.088 });
    expect(sosRes.status).toBe(201);
    expect(sosRes.body.data.status).toBe('OPEN');
    const incidentId = sosRes.body.data.incidentId;
    expect(incidentId).toBeDefined();

    // Driver also triggers SOS on same ride (both allowed)
    const drvSos = await drv.dr.post(`rides/${ride.id}/sos`, { description: 'Rider is threatening' });
    expect(drvSos.status).toBe(201);

    // Admin lists SOS incidents
    const incidents = (await admin.get('admin/safety/incidents')).body.data;
    expect(incidents.length).toBe(2);
    expect(incidents.some((i: any) => i.id === incidentId)).toBe(true);

    // Admin lists only OPEN incidents
    const openIncidents = (await admin.get('admin/safety/incidents?status=OPEN')).body.data;
    expect(openIncidents.length).toBe(2);

    // Admin resolves the rider's incident
    const resolveRes = await admin.post(`admin/safety/incidents/${incidentId}/resolve`, { note: 'Contacted rider, situation resolved safely' });
    expect(resolveRes.status).toBe(201);
    expect(resolveRes.body.data.status).toBe('RESOLVED');

    // Duplicate resolve fails
    const dupe = await admin.post(`admin/safety/incidents/${incidentId}/resolve`, { note: 'Try again...' });
    expect(dupe.status).toBe(409);

    // Now only 1 open incident
    const remaining = (await admin.get('admin/safety/incidents?status=OPEN')).body.data;
    expect(remaining.length).toBe(1);

    // Complete the ride
    for (const s of ['en-route', 'arrive', 'start', 'complete']) {
      await drv.dr.post(`rides/${ride.id}/${s}`).expect(201);
    }

    // SOS on completed ride fails
    const afterComplete = await rider.post(`rides/${ride.id}/sos`, { description: 'Too late' });
    expect(afterComplete.status).toBe(409);
  });

  it('non-participant cannot trigger SOS', async () => {
    const stranger = api((await login('9997700053')).accessToken);
    // Stranger shouldn't even see the ride
    const res = await stranger.post('rides/00000000-0000-0000-0000-000000000000/sos', { description: 'Sneaky' });
    expect(res.status).toBe(404);
  });
});
