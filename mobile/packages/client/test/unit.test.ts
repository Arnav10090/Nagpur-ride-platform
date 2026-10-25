import { describe, it, expect } from 'vitest';
import { ApiClient, ApiError, RealtimeClient, formatINR, isRegistration, normalizeRegistration, parsePhone, userMessage, navigationUrl, decodeJwtExp } from '../src';
import { MemoryTokenStore } from './harness';

describe('formatting and input', () => {
  it('formats rupees with Indian grouping from integer paise', () => {
    expect(formatINR(0)).toBe('₹0.00'); expect(formatINR(5)).toBe('₹0.05'); expect(formatINR(100)).toBe('₹1.00'); expect(formatINR(99999)).toBe('₹999.99');
    expect(formatINR(1234567)).toBe('₹12,345.67'); expect(formatINR(12345678)).toBe('₹1,23,456.78'); expect(formatINR(-2050)).toBe('-₹20.50');
  });
  it('accepts the ways people type Indian mobile numbers; rejects the rest', () => {
    for (const ok of ['9876543210', '98765 43210', '+91 98765 43210', '09876543210', '91 9876543210', '9111111111']) expect(parsePhone(ok), ok).toMatch(/^[6-9]\d{9}$/);
    expect(parsePhone('9111111111')).toBe('9111111111');                       // a valid number that merely starts with 91
    for (const bad of ['', '12345', '5876543210', '98765432101', 'abcdefghij']) expect(parsePhone(bad), bad).toBeNull();
  });
  it('normalises and validates vehicle registrations', () => {
    expect(normalizeRegistration('mh 31-ab 1234')).toBe('MH31AB1234'); expect(isRegistration('MH 31 AB 1234')).toBe(true); expect(isRegistration('MH31 1234')).toBe(true); expect(isRegistration('hello')).toBe(false);
  });
  it('builds a maps deep link and never leaks server text in user messages', () => {
    expect(navigationUrl(21.1, 79.05)).toBe('https://www.google.com/maps/dir/?api=1&destination=21.1,79.05&travelmode=driving');
    expect(userMessage(new ApiError(500, 'WEIRD', 'SQL error at line 4: password'))).not.toMatch(/SQL|password/); expect(userMessage(new Error('stack...'))).toBe('Something went wrong. Please try again.');
    expect(userMessage(new ApiError(0, 'NETWORK', 'x', true))).toMatch(/connection/i);
  });
  it('reads token expiry', () => { const exp = 1234567890; const tok = Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.sig'; expect(decodeJwtExp(tok)).toBe(exp); expect(decodeJwtExp('garbage')).toBeNull(); });
});

type Handler = (url: string, init: any) => Response | Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const mk = (h: Handler, tokens = { accessToken: 'old.sig', refreshToken: 'r1' }, onExpired = () => {}) => {
  const store = new MemoryTokenStore(); store.t = tokens; const calls: string[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push(`${init.method} ${url.replace(/^.*\/api\/v1/, '')}`); return h(url, init); }) as any;
  return { api: new ApiClient({ baseUrl: 'http://x', store, fetchImpl, onSessionExpired: onExpired }), store, calls };
};

describe('ApiClient', () => {
  it('parallel 401s trigger exactly ONE refresh, then every request succeeds with the new token', async () => {
    let refreshes = 0;
    const { api, calls, store } = mk(async (url, init) => {
      if (url.endsWith('/auth/session/refresh')) { refreshes++; await new Promise(r => setTimeout(r, 30)); return json(201, { data: { accessToken: 'new.sig', refreshToken: 'r2' } }); }
      return init.headers.authorization === 'Bearer new.sig' ? json(200, { data: { ok: true } }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } });
    });
    const res = await Promise.all([api.call('GET', '/rides'), api.call('GET', '/rides/1'), api.call('GET', '/rides/2')]);
    expect(res).toHaveLength(3); expect(refreshes).toBe(1); expect(store.t).toEqual({ accessToken: 'new.sig', refreshToken: 'r2' }); expect(calls.filter(c => c.includes('refresh'))).toHaveLength(1);
  });
  it('retries a request only once after refreshing', async () => {
    const { api, calls } = mk(async url => url.endsWith('/refresh') ? json(201, { data: { accessToken: 'n.sig', refreshToken: 'r2' } }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));
    await expect(api.call('GET', '/rides')).rejects.toMatchObject({ status: 401 }); expect(calls.filter(c => c.startsWith('GET'))).toHaveLength(2);
  });
  it('being OFFLINE during a refresh never logs the user out', async () => {
    let expired = 0; const { api, store } = mk(async url => { if (url.endsWith('/refresh')) throw new TypeError('network'); return json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }); }, undefined, () => expired++);
    await expect(api.call('GET', '/rides')).rejects.toMatchObject({ status: 0, code: 'NETWORK' }); expect(expired).toBe(0); expect(store.t).not.toBeNull();
  });
  it('the server rejecting the refresh token ends the session and tells the app', async () => {
    let expired = 0; const { api, store } = mk(async url => url.endsWith('/refresh') ? json(401, { error: { code: 'SESSION_INVALID', message: 'x' } }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }), undefined, () => expired++);
    await expect(api.call('GET', '/rides')).rejects.toBeInstanceOf(ApiError); expect(expired).toBe(1); expect(store.t).toBeNull();
  });
  it('maps server errors to ApiError with code/retryable; network failures to status 0', async () => {
    const a = mk(async () => json(409, { error: { code: 'RIDE_NOT_SEARCHING', message: 'm', retryable: false } })).api; await expect(a.call('POST', '/x')).rejects.toMatchObject({ status: 409, code: 'RIDE_NOT_SEARCHING', retryable: false });
    const b = mk(async () => json(503, { error: { code: 'INTERNAL', message: 'm' } })).api; await expect(b.call('GET', '/x')).rejects.toMatchObject({ retryable: true });
    const c = mk(async () => { throw new TypeError('Failed to fetch'); }).api; await expect(c.call('GET', '/x')).rejects.toMatchObject({ status: 0, retryable: true });
  });
  it('corrects for a wrong phone clock using the server Date header', async () => {
    const skewed = new Date(Date.now() + 5 * 60_000).toUTCString(); const { api } = mk(async () => json(200, { data: 1 }, { date: skewed }));
    await api.call('GET', '/x'); expect(Math.abs(api.now() - (Date.now() + 5 * 60_000))).toBeLessThan(2500);
  });
  it('does not even try to call authenticated endpoints without a session (no token header)', async () => {
    let sawAuth: unknown = 'unset'; const { api } = mk(async (_u, init) => { sawAuth = init.headers.authorization; return json(200, { data: 1 }); }, null as any); await api.requestOtp('9876543210'); expect(sawAuth).toBeUndefined();
  });
});

class FakeSocket { h: Record<string, Function> = {}; any?: Function; closed = false; on(e: string, f: Function) { this.h[e] = f; return this; } onAny(f: Function) { this.any = f; } removeAllListeners() {} close() { this.closed = true; } }
describe('RealtimeClient', () => {
  it('drops duplicate deliveries (the server is at-least-once) and reports connection changes', async () => {
    const sock = new FakeSocket(); const events: string[] = []; const conns: string[] = [];
    const store = new MemoryTokenStore(); store.t = { accessToken: Buffer.from(JSON.stringify({ exp: Date.now() + 3600_000 })).toString('base64url') + '.s', refreshToken: 'r' };
    const api = new ApiClient({ baseUrl: 'http://x', store, fetchImpl: (async () => json(200, {})) as any });
    const rt = new RealtimeClient({ baseUrl: 'http://x', api, ioImpl: (() => sock) as any, onEvent: e => events.push(e.data.eventId), onConnection: c => conns.push(c) });
    rt.start(); await new Promise(r => setTimeout(r, 30)); sock.h.connect!();
    sock.any!('ride.assigned', { eventId: 'e1' }); sock.any!('ride.assigned', { eventId: 'e1' }); sock.any!('ride.status.changed', { eventId: 'e2' }); sock.any!('driver.location', { lat: 1 }); sock.any!('driver.location', { lat: 1 });
    expect(events).toEqual(['e1', 'e2', undefined, undefined]);       // ids are de-duplicated; id-less live pings are passed through
    expect(conns).toContain('CONNECTED'); rt.stop(); expect(sock.closed).toBe(true); expect(conns.at(-1)).toBe('DISCONNECTED');
  });
});
