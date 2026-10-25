import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '../domain/errors';
import { Db, Role } from '../domain/ports';

export type { Role };
export interface Principal { id: string; role: Role; exp?: number }
export interface OtpSender { send(phone: string, code: string): Promise<void> }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const http = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

@Injectable()
export class AuthService {
  constructor(
    @Inject('OTP_SENDER') private sender: OtpSender,
    @Inject('CONFIG') private cfg: { accessKey: string; adminPhones: Record<string, Role>; now: () => number },
    @Inject('DB') private db: Db,
  ) {}

  static normalizePhone(p: string) {
    let d = p.replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (!/^[6-9]\d{9}$/.test(d)) throw http(400, 'INVALID_PHONE', 'Invalid Indian mobile number');
    return '+91' + d;
  }

  async requestOtp(rawPhone: string) {
    const phone = AuthService.normalizePhone(rawPhone); const now = this.cfg.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const throttled = await this.db.tx(async r => {
      const prev = await r.getOtp(phone, true);
      if (prev && now - prev.createdAt < 30_000) return true;
      await r.saveOtp({ phone, hash: sha(phone + code), expires: now + 5 * 60_000, attempts: 0, used: false, createdAt: now });
      return false;
    });
    if (throttled) throw http(429, 'OTP_THROTTLED', 'Wait before requesting another OTP');
    await this.sender.send(phone, code);
  }

  async verifyOtp(rawPhone: string, code: string, role: 'RIDER' | 'DRIVER') {
    const phone = AuthService.normalizePhone(rawPhone); const now = this.cfg.now();
    // Failed attempts must COMMIT (so the limit holds), hence the result is returned and the error thrown after the transaction.
    const res = await this.db.tx(async r => {
      const o = await r.getOtp(phone, true);
      if (!o || o.used || now > o.expires || o.attempts >= 5) return { bad: true } as const;
      const a = Buffer.from(o.hash), b = Buffer.from(sha(phone + code));
      if (a.length !== b.length || !timingSafeEqual(a, b)) { await r.saveOtp({ ...o, attempts: o.attempts + 1 }); return { bad: true } as const; }
      await r.saveOtp({ ...o, used: true }); // single use: concurrent verifies serialise on the row lock, the loser sees used=true
      const user = (await r.getUserByPhone(phone)) ?? (await r.createUser({ id: randomUUID(), phone, role: this.cfg.adminPhones[phone] ?? role, status: 'ACTIVE' }));
      if (user.status !== 'ACTIVE') return { suspended: true } as const;
      return { tokens: await this.issue(r, user.id, user.role) } as const;
    });
    if ('bad' in res) throw http(401, 'OTP_INVALID', 'Invalid or expired OTP');
    if ('suspended' in res) throw http(403, 'ACCOUNT_SUSPENDED', 'Account suspended');
    return res.tokens;
  }

  private async issue(r: Parameters<Parameters<Db['tx']>[0]>[0], userId: string, role: Role) {
    const refreshToken = randomBytes(32).toString('base64url');
    await r.saveSession(sha(refreshToken), userId, this.cfg.now() + REFRESH_TTL_MS);
    return { accessToken: this.sign({ id: userId, role }), refreshToken, expiresInSeconds: 900 };
  }

  /** Rotation. Presenting an already-used refresh token is treated as theft: every session of that user is revoked. */
  async rotate(token: string) {
    const h = sha(token);
    const res = await this.db.tx(async r => {
      const s = await r.getSession(h, true);
      if (!s || this.cfg.now() > s.expiresAt) return { bad: true } as const;
      if (s.revoked) { await r.revokeUserSessions(s.userId); return { bad: true } as const; }
      const u = await r.getUser(s.userId);
      if (!u || u.status !== 'ACTIVE') return { bad: true } as const;
      await r.revokeSession(h);
      return { tokens: await this.issue(r, u.id, u.role) } as const;
    });
    if ('bad' in res) throw http(401, 'SESSION_INVALID', 'Invalid session');
    return res.tokens;
  }
  logout(token: string) { return this.db.tx(r => r.revokeSession(sha(token))); }

  private sign(p: Principal) {
    const body = b64(JSON.stringify({ ...p, exp: this.cfg.now() + 15 * 60_000 }));
    return `${body}.${b64(createHmac('sha256', this.cfg.accessKey).update(body).digest())}`;
  }
  async verify(token: string): Promise<Principal> {
    const bad = () => http(401, 'UNAUTHENTICATED', 'Invalid token');
    const [body, sig] = (token ?? '').split('.');
    const expect = b64(createHmac('sha256', this.cfg.accessKey).update(body ?? '').digest());
    if (!body || !sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw bad();
    let p: any; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw bad(); }
    if (p.exp < this.cfg.now()) throw http(401, 'UNAUTHENTICATED', 'Token expired');
    const u = await this.db.tx(r => r.getUser(p.id));
    if (!u || u.status !== 'ACTIVE') throw http(401, 'UNAUTHENTICATED', 'Account inactive');
    return { id: u.id, role: u.role, exp: p.exp }; // role re-read server-side, never trusted from the token
  }
}

export const Roles = (...r: Role[]) => SetMetadata('roles', r);
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(Reflector) private rf: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw http(401, 'UNAUTHENTICATED', 'Missing token');
    req.user = await this.auth.verify(h.slice(7));
    const roles = this.rf.getAllAndOverride<Role[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(req.user.role)) throw http(403, 'FORBIDDEN', 'Insufficient role');
    return true;
  }
}
export { DomainError };
