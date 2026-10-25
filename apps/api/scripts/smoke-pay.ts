// BASE=http://localhost:3997 LOG=/tmp/pay.log tsx apps/api/scripts/smoke-pay.ts [phase1|phase2]   (server needs ENABLE_DEV_TOOLS=1 and the dev webhook secret)
import { readFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { FakeProvider } from '../src/domain/payments/fakeProvider';
const BASE = process.env.BASE!, LOG = process.env.LOG!, STATE = '/tmp/smoke-pay-state.json';
const gateway = new FakeProvider({ secret: 'dev-only-webhook-secret', now: Date.now });   // what the real gateway would sign with
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const call = async (method: string, path: string, tok?: string, body?: object) => {
  const r = await fetch(BASE + '/api/v1' + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const hook = async (rawBody: string, signature?: string) => { const r = await fetch(BASE + '/api/v1/webhooks/payments/fake', { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-signature': signature } : {}) }, body: rawBody }); return { status: r.status, body: (await r.json().catch(() => ({}))) as any }; };
const otp = (phone: string) => [...readFileSync(LOG, 'utf8').matchAll(new RegExp(`OTP for \\+91${phone}: (\\d{6})`, 'g'))].at(-1)![1]!;
const login = async (phone: string, role = 'RIDER') => { await call('POST', '/auth/otp/request', undefined, { phone }); await sleep(100); const r = await call('POST', '/auth/otp/verify', undefined, { phone, code: otp(phone), role }); if (r.status !== 201) throw new Error('login ' + phone); return r.body.data; };
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const A = { lat: 21.1458, lng: 79.0882 }, B = { lat: 21.1, lng: 79.05 };
const idOf = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).id;

async function phase1() {
  const ops = (await login('9000000009')).accessToken, d = await login('9500000091', 'DRIVER'), r = await login('9600000091');
  await call('POST', '/drivers/onboarding', d.accessToken, { registration: 'MH31UP0091' });
  await call('POST', `/admin/drivers/${idOf(d.accessToken)}/review`, ops, { decision: 'APPROVED', reason: 'smoke approval' });
  await call('POST', '/drivers/me/availability', d.accessToken, { online: true });
  await call('POST', '/drivers/me/location', d.accessToken, { ...A, accuracyMeters: 5, recordedAt: new Date().toISOString(), sequence: 1 });
  const events: any[] = []; const rs = io(BASE, { auth: { token: r.accessToken }, transports: ['websocket'] }); rs.onAny((t, data) => events.push({ t, data })); await sleep(500);
  const q = (await call('POST', '/fare-quotes', r.accessToken, { pickup: A, destination: B })).body.data;
  const ride = (await call('POST', '/rides', r.accessToken, { fareQuoteId: q.id, paymentMethod: 'UPI', idempotencyKey: 'smoke-upi-booking' })).body.data;
  await sleep(1200); const offer = (await call('GET', '/drivers/me/offers', d.accessToken)).body.data[0];
  await call('POST', `/ride-offers/${offer.id}/accept`, d.accessToken);
  for (const s of ['en-route', 'arrive', 'start']) await call('POST', `/rides/${ride.id}/${s}`, d.accessToken);
  const done = await call('POST', `/rides/${ride.id}/complete`, d.accessToken);
  ok(done.body.data.paymentStatus === 'REQUIRES_ACTION', 'completing a UPI ride created a provider payment awaiting the rider');
  const pay = (await call('GET', `/rides/${ride.id}/payment`, r.accessToken)).body.data; const ref = new URL(pay.intent.upiUri).searchParams.get('tr')!;
  ok(pay.intent.upiUri.startsWith('upi://pay?') && pay.amountMinor === q.fare.totalMinor, 'rider received a UPI intent for the exact fare');

  const ev = gateway.signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: pay.amountMinor, eventId: 'evt-smoke-capture-1' });
  ok((await hook(ev.rawBody)).status === 401, 'webhook without a signature -> 401 (live, raw body)');
  ok((await hook(ev.rawBody, new FakeProvider({ secret: 'attacker', now: Date.now }).signature(ev.rawBody))).status === 401, 'webhook signed with the wrong secret -> 401');
  ok((await hook(ev.rawBody.replace(String(pay.amountMinor), '1'), ev.signature)).status === 401, 'tampered amount -> 401');
  ok((await call('GET', `/rides/${ride.id}/payment`, r.accessToken)).body.data.status === 'REQUIRES_ACTION', 'forged webhooks changed nothing');
  const good = await hook(ev.rawBody, ev.signature); ok(good.status === 200 && good.body.outcome === 'CAPTURED', 'genuine signed webhook -> CAPTURED');
  const dup = await hook(ev.rawBody, ev.signature); ok(dup.status === 200 && dup.body.outcome === 'DUPLICATE', 'identical webhook replayed -> 200 DUPLICATE, no second effect');
  await sleep(1500);
  ok(events.some(e => e.t === 'payment.status.changed' && e.data.status === 'SUCCEEDED'), 'rider got payment.status.changed SUCCEEDED over the socket (real outbox worker)');
  ok(!JSON.stringify(events).includes('upi://'), 'no UPI intent or secret leaked through realtime events');
  ok((await call('POST', '/dev/fake-pay/nope', undefined, {})).status === 404, 'dev tools enabled and reachable (unknown payment -> 404 JSON)');
  writeFileSync(STATE, JSON.stringify({ r, rideId: ride.id, ref, amount: pay.amountMinor })); rs.close();
}
async function phase2() {
  const { r, rideId, ref, amount } = JSON.parse(readFileSync(STATE, 'utf8'));
  ok((await call('GET', `/rides/${rideId}/payment`, r.accessToken)).body.data.status === 'SUCCEEDED', 'after restart: payment still SUCCEEDED');
  const again = gateway.signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: amount, eventId: 'evt-smoke-capture-1' });
  const dup = await hook(again.rawBody, again.signature); ok(dup.body.outcome === 'DUPLICATE', 'after restart: the SAME event id (fresh signature) is still recognised as a duplicate');
  const other = gateway.signedEvent({ type: 'payment.succeeded', providerRef: ref, amountMinor: amount }); const ig = await hook(other.rawBody, other.signature);
  ok(ig.status === 200 && ig.body.outcome === 'IGNORED', 'after restart: a re-sent success under a new id is ignored (no double booking)');
  const fin = (await login('9000000008')).accessToken;
  ok((await call('POST', `/admin/payments/${rideId}/refund`, r.accessToken, { amountMinor: 100, reason: 'rider tries' })).status === 403, 'a rider cannot refund');
  const rf = await call('POST', `/admin/payments/${rideId}/refund`, fin, { amountMinor: 1500, reason: 'smoke partial refund' }); ok(rf.status === 201, 'finance admin refund accepted');
  await sleep(300); const p = (await call('GET', `/rides/${rideId}/payment`, r.accessToken)).body.data; ok(p.status === 'PARTIALLY_REFUNDED' && p.refundedMinor === 1500, 'payment is PARTIALLY_REFUNDED by exactly the refunded amount');
  ok((await call('POST', `/admin/payments/${rideId}/refund`, fin, { amountMinor: amount, reason: 'more than remains' })).status === 409, 'refunding more than remains -> 409');
}
(process.argv[2] === 'phase2' ? phase2() : phase1()).then(() => process.exit());
