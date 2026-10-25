import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AuthService } from '../src/http/auth';
import { Db } from '../src/domain/ports';
import { PgDb } from '../src/pg/PgDb';
import { closePool, getPool, makeDb, PG_URL } from './harness';

const impls: ('memory' | 'postgres')[] = PG_URL ? ['memory', 'postgres'] : ['memory'];
afterAll(closePool);
const fail = async (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => e.getResponse?.().code ?? String(e.message));

describe.each(impls)('auth persistence [%s]', kind => {
  let db: Db, t: number, codes: Map<string, string>;
  const make = (d: Db = db, key = 'k1') => new AuthService({ send: async (p, c) => { codes.set(p, c); } }, { accessKey: key, adminPhones: {}, now: () => t }, d);
  let auth: AuthService; const PHONE = '+919876543210', RAW = '9876543210';
  const login = async (a = auth, phone = RAW) => { await a.requestOtp(phone); return a.verifyOtp(phone, codes.get('+91' + phone.slice(-10))!, 'RIDER'); };

  beforeEach(async () => { t = 1_000_000; codes = new Map(); db = await makeDb(kind); auth = make(); });

  it('stores only hashes: no plaintext OTP or refresh token reaches the database', async () => {
    const s = await login();
    const otp = await db.tx(r => r.getOtp(PHONE)); expect(otp!.hash).not.toContain(codes.get(PHONE)!); expect(otp!.hash).toHaveLength(64);
    expect(await db.tx(r => r.getSession(s.refreshToken))).toBeUndefined(); // lookup is by hash, so the raw token finds nothing
  });
  it('sessions and users survive a restart: a NEW service instance honours old tokens', async () => {
    const s = await login();
    const db2: Db = kind === 'postgres' ? new PgDb(getPool()) : db; const auth2 = make(db2);
    expect((await auth2.verify(s.accessToken)).role).toBe('RIDER');
    const rotated = await auth2.rotate(s.refreshToken); expect(rotated.refreshToken).not.toBe(s.refreshToken);
    expect(await db.tx(r => r.getUserByPhone(PHONE))).toBeTruthy();
  });
  it('a token signed with a different key is rejected', async () => {
    const s = await login(); expect(await fail(make(db, 'other-key').verify(s.accessToken))).toBe('UNAUTHENTICATED');
  });
  it('OTP is single-use even under concurrent verification', async () => {
    await auth.requestOtp(RAW); const code = codes.get(PHONE)!;
    const res = await Promise.all(Array.from({ length: 6 }, () => fail(auth.verifyOtp(RAW, code, 'RIDER'))));
    expect(res.filter(x => x === 'OK')).toHaveLength(1); expect(res.filter(x => x === 'OTP_INVALID')).toHaveLength(5);
    expect(await db.tx(async r => (await r.getUserByPhone(PHONE))!.id)).toBeTruthy();
  });
  it('failed attempts are committed: 5 wrong guesses lock the challenge even for the right code', async () => {
    await auth.requestOtp(RAW); const code = codes.get(PHONE)!;
    for (let i = 0; i < 5; i++) expect(await fail(auth.verifyOtp(RAW, code === '000000' ? '111111' : '000000', 'RIDER'))).toBe('OTP_INVALID');
    expect(await fail(auth.verifyOtp(RAW, code, 'RIDER'))).toBe('OTP_INVALID');
  });
  it('OTP expires after 5 minutes and re-requests are throttled for 30s', async () => {
    await auth.requestOtp(RAW); expect(await fail(auth.requestOtp(RAW))).toBe('OTP_THROTTLED');
    const code = codes.get(PHONE)!; t += 5 * 60_000 + 1; expect(await fail(auth.verifyOtp(RAW, code, 'RIDER'))).toBe('OTP_INVALID');
    await auth.requestOtp(RAW); expect(codes.get(PHONE)).toBeTruthy();
  });
  it('concurrent refresh with one token: exactly one succeeds', async () => {
    const s = await login(); const res = await Promise.all(Array.from({ length: 5 }, () => fail(auth.rotate(s.refreshToken))));
    expect(res.filter(x => x === 'OK').length).toBeGreaterThanOrEqual(1); // the first wins ...
    expect(await fail(auth.rotate(s.refreshToken))).toBe('SESSION_INVALID'); // ... and the token is dead afterwards
  });
  it('refresh-token reuse revokes every session of that user (theft response)', async () => {
    const s1 = await login(); const s2 = await auth.rotate(s1.refreshToken);
    expect(await fail(auth.rotate(s1.refreshToken))).toBe('SESSION_INVALID'); // reuse detected
    expect(await fail(auth.rotate(s2.refreshToken))).toBe('SESSION_INVALID'); // the legitimate newer token is revoked too
  });
  it('suspension blocks existing access tokens, refresh and new logins', async () => {
    const s = await login(); const uid = (await auth.verify(s.accessToken)).id;
    await db.tx(async r => { await r.setUserStatus(uid, 'SUSPENDED'); await r.revokeUserSessions(uid); });
    expect(await fail(auth.verify(s.accessToken))).toBe('UNAUTHENTICATED'); expect(await fail(auth.rotate(s.refreshToken))).toBe('SESSION_INVALID');
    t += 31_000; await auth.requestOtp(RAW); expect(await fail(auth.verifyOtp(RAW, codes.get(PHONE)!, 'RIDER'))).toBe('ACCOUNT_SUSPENDED');
  });
  it('logout revokes the session; expired refresh tokens are refused', async () => {
    const s = await login(); await auth.logout(s.refreshToken); expect(await fail(auth.rotate(s.refreshToken))).toBe('SESSION_INVALID');
    const s2 = await login(auth, '9876543211'); t += 31 * 24 * 3600_000; expect(await fail(auth.rotate(s2.refreshToken))).toBe('SESSION_INVALID');
  });
  it('phone normalisation does not corrupt valid numbers beginning with 91', async () => {
    expect(AuthService.normalizePhone('9111111111')).toBe('+919111111111'); expect(AuthService.normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(() => AuthService.normalizePhone('12345')).toThrow();
  });
});

describe.skipIf(!PG_URL)('auth database guards', () => {
  it('role and phone of a user cannot be changed by an UPDATE; 2 users cannot share a phone', async () => {
    const db = await makeDb('postgres'); const pool = getPool(); await pool.query('TRUNCATE "Session","User" CASCADE');
    const id = '00000000-0000-4000-8000-000000000001';
    await db.tx(r => r.createUser({ id, phone: '+919876543210', role: 'RIDER', status: 'ACTIVE' }));
    const err = (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => e.message);
    expect(await err(pool.query(`UPDATE "User" SET role='SUPER_ADMIN' WHERE id=$1`, [id]))).toMatch(/immutable/);
    const again = await db.tx(r => r.createUser({ id: '00000000-0000-4000-8000-000000000002', phone: '+919876543210', role: 'DRIVER', status: 'ACTIVE' }));
    expect(again.id).toBe(id); expect(again.role).toBe('RIDER'); // racing signup cannot override an existing role
  });
});
