import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { io as connect, Socket } from 'socket.io-client';
import { DispatchService } from '../src/domain/dispatch';
import { OutboxWorker } from '../src/domain/outbox';
import { Db } from '../src/domain/ports';
import { AuthService } from '../src/http/auth';
import { buildModule, ErrorFilter } from '../src/http/app.module';
import { noopRateLimiters } from '../src/http/rateLimit';
import { LiveHub } from '../src/http/realtime';
import { closePool, makeDb, PG_URL } from './harness';

let app: any, http: any, db: Db, hub: LiveHub, worker: OutboxWorker, port: number, t = 9_000_000;
const codes = new Map<string, string>(); const sockets: Socket[] = [];
beforeAll(async () => {
  db = await makeDb(PG_URL ? 'postgres' : 'memory'); hub = new LiveHub();
  app = await NestFactory.create(buildModule({ db, hub, accessKey: 'rt-key', now: () => t, adminPhones: { '+919000000009': 'OPS_ADMIN' }, rateLimiters: noopRateLimiters(), sender: { async send(p, c) { codes.set(p, c); } } }), { logger: false });
  app.useGlobalFilters(new ErrorFilter()); await app.init(); hub.attach(app.getHttpServer(), app.get(AuthService));
  await app.listen(0); http = app.getHttpServer(); port = http.address().port;
  worker = new OutboxWorker(db, hub, () => t);
});
afterAll(async () => { sockets.forEach(s => s.close()); await hub.close(); await app.close(); await closePool(); });

const seen = new Set<string>();
const login = async (phone: string, role: 'RIDER' | 'DRIVER' = 'RIDER') => {
  if (seen.has(phone)) t += 31_000; seen.add(phone);
  await request(http).post('/api/v1/auth/otp/request').send({ phone });
  const r = await request(http).post('/api/v1/auth/otp/verify').send({ phone, code: codes.get('+91' + phone), role }).expect(201);
  return r.body.data.accessToken as string;
};
const api = (tok: string) => ({ post: (u: string, b: object = {}) => request(http).post('/api/v1' + u).set('Authorization', 'Bearer ' + tok).send(b), get: (u: string) => request(http).get('/api/v1' + u).set('Authorization', 'Bearer ' + tok) });
const sock = async (token: string) => {
  const s = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false }); sockets.push(s);
  const log: { type: string; data: any }[] = []; s.onAny((type, data) => log.push({ type, data }));
  await new Promise<void>((res, rej) => { s.on('connect', () => res()); s.on('connect_error', e => rej(e)); });
  return { s, log };
};
const settle = async () => { await worker.tick(); await new Promise(r => setTimeout(r, 120)); };
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };

describe('realtime delivery', () => {
  it('rejects missing and forged tokens at the handshake', async () => {
    await expect(sock('')).rejects.toThrow('UNAUTHENTICATED'); await expect(sock('abc.def')).rejects.toThrow('UNAUTHENTICATED');
  });

  it('delivers offers, assignment, status changes and live location ONLY to the right people', async () => {
    const adminTok = await login('9000000009'); const admin = api(adminTok);
    const dTok = await login('9300000001', 'DRIVER'); const dr = api(dTok);
    const dId = JSON.parse(Buffer.from(dTok.split('.')[0]!, 'base64url').toString()).id;
    await dr.post('/drivers/onboarding', { registration: 'MH31RT0001' }).expect(201); await admin.post(`/admin/drivers/${dId}/review`, { decision: 'APPROVED', reason: 'documents verified' }).expect(201);
    await dr.post('/drivers/me/availability', { online: true }).expect(201);
    await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 1 }).expect(201);
    const rTok = await login('9300000002'); const rider = api(rTok); const strangerTok = await login('9300000003');

    const D = await sock(dTok), R = await sock(rTok), X = await sock(strangerTok);
    const q = (await rider.post('/fare-quotes', { pickup: A, destination: B })).body.data;
    const ride = (await rider.post('/rides', { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'realtime-book-1' }).expect(201)).body.data;
    await settle();

    const offer = D.log.find(e => e.type === 'ride.offer.created')!.data;
    expect(offer.rideId).toBe(ride.id); expect(offer.driverId).toBe(dId);
    expect(R.log.some(e => e.type === 'ride.offer.created')).toBe(false);          // riders never see offers
    expect(R.log.find(e => e.type === 'ride.status.changed')!.data.status).toBe('SEARCHING');

    await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 2 });
    await new Promise(r => setTimeout(r, 80));
    expect(R.log.some(e => e.type === 'driver.location')).toBe(false);              // no tracking before assignment

    await dr.post(`/ride-offers/${offer.offerId}/accept`).expect(201); await settle();
    expect(R.log.some(e => e.type === 'ride.assigned')).toBe(true);
    expect(D.log.filter(e => e.type === 'ride.status.changed').map(e => e.data.status)).toContain('DRIVER_ASSIGNED');

    await dr.post('/drivers/me/location', { lat: 21.147, lng: 79.09, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 3 });
    await new Promise(r => setTimeout(r, 120));
    expect(R.log.find(e => e.type === 'driver.location')!.data).toMatchObject({ rideId: ride.id, lat: 21.147, lng: 79.09 });

    for (const s of ['en-route', 'arrive', 'start', 'complete']) await dr.post(`/rides/${ride.id}/${s}`).expect(201);
    await settle();
    const versions = R.log.filter(e => e.type === 'ride.status.changed').map(e => e.data.stateVersion);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));                  // monotonic stateVersion lets clients drop stale events
    expect(R.log.filter(e => e.type === 'ride.status.changed').pop()!.data.status).toBe('COMPLETED');
    expect(new Set(R.log.map(e => e.data.eventId).filter(Boolean)).size).toBe(R.log.filter(e => e.data.eventId).length); // unique ids for dedupe

    expect(X.log).toEqual([]);                                                       // an unrelated user receives nothing at all
    await dr.post('/drivers/me/location', { ...A, accuracyMeters: 5, recordedAt: new Date(t).toISOString(), sequence: 4 });
    await new Promise(r => setTimeout(r, 80)); expect(R.log.filter(e => e.type === 'driver.location')).toHaveLength(1); // none after completion
  });

  it('clients cannot join other users\' rooms or inject events', async () => {
    const aTok = await login('9300000011'); const bTok = await login('9300000012');
    const bId = JSON.parse(Buffer.from(bTok.split('.')[0]!, 'base64url').toString()).id;
    const A1 = await sock(aTok); const B1 = await sock(bTok);
    A1.s.emit('join', `user:${bId}`); A1.s.emit('subscribe', { room: `user:${bId}` }); A1.s.emit('ride.assigned', { fake: true });
    await new Promise(r => setTimeout(r, 100));
    hub.emitToUser(bId, 'driver.location', { rideId: 'x' }); await new Promise(r => setTimeout(r, 100));
    expect(B1.log).toHaveLength(1); expect(A1.log).toEqual([]);
  });

  it('events published before the hub could deliver stay pending and are not lost', async () => {
    const detached = new LiveHub(); const w = new OutboxWorker(db, detached, () => t, { baseBackoffMs: 1, maxAttempts: 50 });
    await db.tx(r => r.emit('ride.status.changed', 'ride-z', { riderId: 'u', driverId: null, status: 'SEARCHING', stateVersion: 2 }));
    expect((await w.tick()).retried).toBeGreaterThanOrEqual(1);
    t += 10_000; const live = new OutboxWorker(db, hub, () => t); expect((await live.tick()).delivered).toBeGreaterThanOrEqual(1);
  });

  it('revalidation disconnects sockets whose token expired or whose account was suspended', async () => {
    const adminTok = await login('9000000009'); const admin = api(adminTok);
    const uTok = await login('9300000021', 'DRIVER'); const uId = JSON.parse(Buffer.from(uTok.split('.')[0]!, 'base64url').toString()).id;
    const U = await sock(uTok); const closed = new Promise<string>(res => U.s.on('disconnect', r => res(r)));
    await admin.post(`/admin/drivers/${uId}/suspend`, { reason: 'fraud check' }).expect(201);
    await hub.revalidate(); expect(await closed).toBe('io server disconnect');
    const eTok = await login('9300000022'); const E = await sock(eTok); const closed2 = new Promise<string>(res => E.s.on('disconnect', r => res(r)));
    t += 16 * 60_000; await hub.revalidate(); expect(await closed2).toBe('io server disconnect');
    t -= 16 * 60_000;
  });
});
