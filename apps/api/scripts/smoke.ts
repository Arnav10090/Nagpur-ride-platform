// Live smoke test against a RUNNING server:  BASE=http://localhost:3998 LOG=/tmp/boot.log tsx apps/api/scripts/smoke.ts [phase1|phase2]
import { readFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
const BASE = process.env.BASE!, LOG = process.env.LOG!, STATE = '/tmp/smoke-state.json', ADMIN = '9000000009';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const call = async (method: string, path: string, tok?: string, body?: object) => {
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const otp = (phone: string) => { const m = [...readFileSync(LOG, 'utf8').matchAll(new RegExp(`OTP for \\+91${phone}: (\\d{6})`, 'g'))]; return m.at(-1)![1]!; };
const login = async (phone: string, role = 'RIDER') => { await call('POST', '/auth/otp/request', undefined, { phone }); await sleep(100); const r = await call('POST', '/auth/otp/verify', undefined, { phone, code: otp(phone), role }); if (r.status !== 201) throw new Error('login ' + phone + ' ' + r.status); return r.body.data; };
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
const idOf = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id;

async function phase1() {
  const admin = (await login(ADMIN)).accessToken; const d = await login('9400000001', 'DRIVER'); const r = await login('9400000002');
  await call('POST', '/drivers/onboarding', d.accessToken, { registration: 'MH31SM0001' });
  await call('POST', `/admin/drivers/${idOf(d.accessToken)}/review`, admin, { decision: 'APPROVED', reason: 'smoke test approval' });
  ok((await call('POST', '/drivers/me/availability', d.accessToken, { online: true })).status === 201, 'driver approved and online');
  await call('POST', '/drivers/me/location', d.accessToken, { ...A, accuracyMeters: 5, recordedAt: new Date().toISOString(), sequence: 1 });
  const events: string[] = []; const sock = (tok: string, tag: string) => { const s = io(BASE, { auth: { token: tok }, transports: ['websocket'] }); s.onAny(t => events.push(`${tag}:${t}`)); return s; };
  const ds = sock(d.accessToken, 'driver'), rs = sock(r.accessToken, 'rider'); await sleep(500);
  const q = (await call('POST', '/fare-quotes', r.accessToken, { pickup: A, destination: B })).body.data;
  const ride = (await call('POST', '/rides', r.accessToken, { fareQuoteId: q.id, paymentMethod: 'CASH', idempotencyKey: 'smoke-booking-1' })).body.data;
  await sleep(1500); // real outbox worker, no manual ticks
  ok(events.includes('driver:ride.offer.created'), 'driver got the offer pushed by the real outbox worker');
  const offer = (await call('GET', '/drivers/me/offers', d.accessToken)).body.data[0];
  await call('POST', `/ride-offers/${offer.id}/accept`, d.accessToken); await sleep(1000);
  ok(events.includes('rider:ride.assigned'), 'rider got ride.assigned in real time');
  writeFileSync(STATE, JSON.stringify({ d, r, rideId: ride.id })); ds.close(); rs.close();
}
async function phase2() {
  const { d, r, rideId } = JSON.parse(readFileSync(STATE, 'utf8'));
  ok((await call('GET', '/drivers/me/status', d.accessToken)).body.data?.verification === 'APPROVED', 'after restart: driver token still valid and profile intact');
  const ride = await call('GET', `/rides/${rideId}`, r.accessToken); ok(ride.body.data?.status === 'DRIVER_ASSIGNED', 'after restart: ride still DRIVER_ASSIGNED');
  const rot = await call('POST', '/auth/session/refresh', undefined, { refreshToken: r.refreshToken }); ok(rot.status === 201, 'after restart: refresh token rotates');
  for (const s of ['en-route', 'arrive', 'start', 'complete']) await call('POST', `/rides/${rideId}/${s}`, d.accessToken);
  ok((await call('GET', `/rides/${rideId}`, r.accessToken)).body.data?.status === 'COMPLETED', 'after restart: trip completes');
}
(process.argv[2] === 'phase2' ? phase2() : phase1()).then(() => process.exit());
