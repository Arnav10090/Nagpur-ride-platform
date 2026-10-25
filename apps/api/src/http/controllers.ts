import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DispatchService } from '../domain/dispatch';
import { DomainError } from '../domain/errors';
import { RideCommand } from '../domain/rideStateMachine';
import { AuthGuard, AuthService, Roles } from './auth';
import { Platform } from './platform';
import { maskPhone } from './mask';
import type { Role } from '../domain/ports';
import { PaymentService } from '../domain/payments/service';
import { PaymentProvider, SignatureError } from '../domain/payments/provider';
import { FakeProvider } from '../domain/payments/fakeProvider';
import type { RateLimiters } from './rateLimit';

const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpException({ code: 'VALIDATION_ERROR', message: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
  return r.data;
};
const ll = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const env = (data: unknown) => ({ data, meta: { requestId: crypto.randomUUID() } });

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private a: AuthService, @Inject('RATE_LIMITERS') private rl: RateLimiters) {}
  @Post('otp/request') async req(@Body() b: unknown, @Req() req: any) {
    const { phone } = parse(z.object({ phone: z.string() }), b);
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (!this.rl.otpByIp.check(`ip:${ip}`)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many OTP requests from this address' }, 429);
    if (!this.rl.otp.check(`phone:${phone}`)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many OTP requests for this number' }, 429);
    await this.a.requestOtp(phone); return env({ sent: true });
  }
  @Post('otp/verify') async verify(@Body() b: unknown) { const x = parse(z.object({ phone: z.string(), code: z.string().length(6), role: z.enum(['RIDER', 'DRIVER']).default('RIDER') }), b); return env(await this.a.verifyOtp(x.phone, x.code, x.role)); }
  @Post('session/refresh') async refresh(@Body() b: unknown) { return env(await this.a.rotate(parse(z.object({ refreshToken: z.string() }), b).refreshToken)); }
  @Post('session/logout') async logout(@Body() b: unknown) { await this.a.logout(parse(z.object({ refreshToken: z.string() }), b).refreshToken); return env({ ok: true }); }
}

@Controller('api/v1')
@UseGuards(AuthGuard)
export class RidesController {
  constructor(@Inject(Platform) private p: Platform, @Inject(DispatchService) private d: DispatchService, @Inject('RATE_LIMITERS') private rl: RateLimiters) {}

  @Post('fare-quotes') @Roles('RIDER')
  async quote(@Req() r: any, @Body() b: unknown) {
    const x = parse(z.object({ category: z.string().default('AUTO'), pickup: ll, destination: ll }), b);
    return env(await this.p.quote(r.user.id, x.category, x.pickup, x.destination));
  }
  @Get('fare-quotes/:id') @Roles('RIDER')
  async getQuote(@Req() r: any, @Param('id') id: string) {
    const q = await this.p.db.tx(db => db.getQuote(id));
    if (!q || q.riderId !== r.user.id) throw new HttpException({ code: 'NOT_FOUND', message: 'Quote not found' }, 404);
    return env(q);
  }
  @Post('rides') @Roles('RIDER')
  async create(@Req() r: any, @Body() b: unknown) {
    if (!this.rl.booking.check(`rider:${r.user.id}`)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many booking requests' }, 429);
    const x = parse(z.object({ fareQuoteId: z.string(), paymentMethod: z.enum(['CASH', 'UPI']), idempotencyKey: z.string().min(8).max(100) }), b);
    const q = await this.p.ownedQuote(r.user.id, x.fareQuoteId); // fare comes from the quote, never from the client
    return env(await this.d.createRide({ riderId: r.user.id, zoneId: q.zoneId, category: q.category, pickup: q.pickup, idempotencyKey: x.idempotencyKey, fareQuoteId: q.id, paymentMethod: x.paymentMethod }));
  }
  @Get('rides') @Roles('RIDER')
  async list(@Req() r: any, @Query() q: unknown) {
    const { limit, cursor } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.coerce.number().int().min(0).default(0) }), q);
    const all = await this.p.db.tx(x => x.listRideSummaries(r.user.id, limit + 1 + cursor));
    const page = all.slice(cursor, cursor + limit);
    return env({ rides: page, nextCursor: all.length > cursor + limit ? cursor + limit : null });
  }
  @Get('rides/:id') async get(@Req() r: any, @Param('id') id: string) { return env(await this.p.rideView(r.user.id, id)); }

  @Post('rides/:id/cancel') async cancel(@Req() r: any, @Param('id') id: string) {
    await this.p.visibleRide(r.user.id, id);
    const kind = r.user.role === 'DRIVER' ? 'DRIVER' : 'RIDER';
    return env(await this.p.cancel(id, { kind, id: r.user.id }));
  }
  @Post('rides/:id/en-route') @Roles('DRIVER') enRoute(@Req() r: any, @Param('id') id: string) { return this.run(id, 'DRIVER_EN_ROUTE', r.user); }
  @Post('rides/:id/arrive') @Roles('DRIVER') arrive(@Req() r: any, @Param('id') id: string) { return this.run(id, 'ARRIVE', r.user); }
  @Post('rides/:id/start') @Roles('DRIVER') start(@Req() r: any, @Param('id') id: string) { return this.run(id, 'START_TRIP', r.user); }
  @Post('rides/:id/complete') @Roles('DRIVER')
  async complete(@Req() r: any, @Param('id') id: string) { await this.p.visibleRide(r.user.id, id); return env(await this.p.complete(id, { kind: 'DRIVER', id: r.user.id })); }

  /** Rate a ride: riders rate the driver, drivers rate the rider. 1-5 stars, optional comment. One rating per role per ride. */
  @Post('rides/:id/rate')
  async rate(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }), b);
    const ride = await this.p.visibleRide(r.user.id, id);
    if (ride.status !== 'COMPLETED') throw new HttpException({ code: 'INVALID_TRANSITION', message: 'Can only rate completed rides' }, 409);
    const role = ride.riderId === r.user.id ? 'RIDER' : 'DRIVER';
    const toUserId = role === 'RIDER' ? ride.driverId! : ride.riderId;
    return env(await this.p.db.tx(async db => {
      const existing = await db.getRatingByRideAndRole(id, role);
      if (existing) throw new HttpException({ code: 'ALREADY_RATED', message: 'Already rated this ride' }, 409);
      const rating = { id: randomUUID(), rideId: id, fromUserId: r.user.id, toUserId, role: role as 'RIDER' | 'DRIVER', stars: x.stars, comment: x.comment ?? null, createdAt: this.p.now() };
      await db.insertRating(rating);
      return { rated: true, stars: x.stars };
    }));
  }

  /** RDR-10 / ADM-06: SOS panic button during an active ride. Creates an incident for ops to handle. */
  @Post('rides/:id/sos')
  async sos(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ description: z.string().max(500).default('SOS triggered'), lat: z.number().optional(), lng: z.number().optional() }), b);
    const ride = await this.p.visibleRide(r.user.id, id);
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(ride.status)) throw new HttpException({ code: 'INVALID_TRANSITION', message: 'Ride is not active' }, 409);
    const role = ride.riderId === r.user.id ? 'RIDER' : 'DRIVER';
    const incident = { id: randomUUID(), rideId: id, reporterId: r.user.id, reporterRole: role as 'RIDER' | 'DRIVER',
      location: x.lat != null && x.lng != null ? { lat: x.lat, lng: x.lng } : null,
      description: x.description, status: 'OPEN' as const, createdAt: this.p.now(), resolvedAt: null, resolvedBy: null, resolvedNote: null };
    await this.p.db.tx(async db => {
      await db.insertSosIncident(incident);
      await db.emit('safety.sos.triggered', id, { incidentId: incident.id, reporterId: r.user.id, reporterRole: role });
    });
    return env({ incidentId: incident.id, status: 'OPEN' });
  }

  private async run(id: string, cmd: RideCommand, u: { id: string; role: string }) {
    await this.p.visibleRide(u.id, id); // 404 for non-participants
    const kind = u.role === 'DRIVER' ? 'DRIVER' : 'RIDER';
    return env(await this.d.command(id, cmd, { kind, id: u.id }));
  }
}

@Controller('api/v1')
@UseGuards(AuthGuard)
@Roles('DRIVER')
export class DriversController {
  constructor(@Inject(Platform) private p: Platform, @Inject(DispatchService) private d: DispatchService, @Inject('RATE_LIMITERS') private rl: RateLimiters) {}

  @Post('drivers/onboarding')
  async onboard(@Req() r: any, @Body() b: unknown) {
    const x = parse(z.object({ category: z.string().default('AUTO'), registration: z.string().min(6).max(15) }), b);
    const reg = x.registration.replace(/[\s-]/g, '').toUpperCase();
    await this.p.db.tx(async db => { const prev = await db.getProfile(r.user.id);
      await db.saveProfile({ userId: r.user.id, verification: 'PENDING', category: x.category, registration: reg, lastSeq: prev?.lastSeq ?? -1 }); }); // unique registration enforced by the database
    return env({ verification: 'PENDING' });
  }
  @Get('drivers/me/status')
  async status(@Req() r: any) {
    return env(await this.p.db.tx(async db => ({ verification: (await db.getProfile(r.user.id))?.verification ?? 'NOT_SUBMITTED', online: !!(await db.getDriver(r.user.id))?.online })));
  }
  /** Lets a driver app that was killed mid-trip resume exactly where it was. */
  @Get('drivers/me/active-ride')
  async active(@Req() r: any) {
    const d = await this.p.db.tx(db => db.getDriver(r.user.id));
    return env(d?.activeRideId ? await this.p.rideView(r.user.id, d.activeRideId) : null);
  }

  @Post('drivers/me/availability')
  async availability(@Req() r: any, @Body() b: unknown) {
    const { online } = parse(z.object({ online: z.boolean() }), b);
    if (!online) { await this.d.goOffline(r.user.id); return env({ online: false }); }
    await this.p.db.tx(async db => {
      const prof = await db.getProfile(r.user.id);
      if (prof?.verification !== 'APPROVED') throw new DomainError('FORBIDDEN', 'Driver not approved'); // DRV-01/02 server-side
      const s = await db.getDriver(r.user.id, true);
      await db.saveDriver({ id: r.user.id, approved: true, online: true, vehicleCategory: prof.category, zoneId: 'nagpur-pilot', lat: s?.lat ?? 21.1458, lng: s?.lng ?? 79.0882, lastLocationAt: s?.lastLocationAt ?? 0, activeRideId: s?.activeRideId ?? null });
    });
    return env({ online: true });
  }
  @Post('drivers/me/location')
  async location(@Req() r: any, @Body() b: unknown) {
    if (!this.rl.location.check(`driver:${r.user.id}`)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Location updates too frequent' }, 429);
    const x = parse(ll.extend({ accuracyMeters: z.number().min(0).max(5000), recordedAt: z.string().datetime(), sequence: z.number().int().min(0) }), b);
    return env(await this.p.db.tx(async db => {
      const s = await db.getDriver(r.user.id, true); const prof = await db.getProfile(r.user.id);
      if (!s || !s.online || !prof) throw new DomainError('FORBIDDEN', 'Go online first');
      if (x.sequence <= prof.lastSeq) return { accepted: false, reason: 'OUT_OF_ORDER' };
      if (Date.parse(x.recordedAt) > this.p.now() + 60_000) throw new HttpException({ code: 'VALIDATION_ERROR', message: 'recordedAt in the future' }, 400);
      if (x.accuracyMeters > 100 || !this.p.inZone(x)) return { accepted: false, reason: 'REJECTED_FIX' };
      await db.saveDriver({ ...s, lat: x.lat, lng: x.lng, lastLocationAt: this.p.now() }); // freshness uses SERVER receipt time
      await db.saveProfile({ ...prof, lastSeq: x.sequence });
      // Live tracking: only to the rider of this driver's ACTIVE ride; ephemeral, never persisted or queued.
      const ride = s.activeRideId ? await db.getRide(s.activeRideId) : undefined;
      if (ride && ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(ride.status))
        this.p.hub.emitToUser(ride.riderId, 'driver.location', { rideId: ride.id, lat: x.lat, lng: x.lng, at: this.p.now() });
      return { accepted: true };
    }));
  }
  @Get('drivers/me/offers')
  async offers(@Req() r: any) {
    return env(await this.p.db.tx(async db => {
      const out = [];
      for (const o of await db.pendingOffersForDriver(r.user.id)) if (o.expiresAt > this.p.now())
        out.push({ id: o.id, rideId: o.rideId, expiresAt: o.expiresAt, pickup: (await db.getRequest(o.rideId)).pickup });
      return out;
    }));
  }
  @Post('ride-offers/:id/accept') async accept(@Req() r: any, @Param('id') id: string) { return env(await this.d.acceptOffer(id, r.user.id)); }
  @Post('ride-offers/:id/reject') async reject(@Req() r: any, @Param('id') id: string) { await this.d.rejectOffer(id, r.user.id); return env({ ok: true }); }

  /** DRV-09: Driver earnings summary. */
  @Get('drivers/me/earnings')
  async earnings(@Req() r: any) {
    return env(await this.p.db.tx(db => db.driverEarnings(r.user.id)));
  }

  /** Driver's average rating. */
  @Get('drivers/me/rating')
  async rating(@Req() r: any) {
    return env(await this.p.db.tx(db => db.averageRating(r.user.id)));
  }
}

@Controller('api/v1')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(@Inject(Platform) private p: Platform, @Inject(PaymentService) private pay: PaymentService) {}
  /** Rider and driver may see payment status; only the rider receives the UPI intent. Cash rides have no payment record. */
  @Get('rides/:id/payment')
  async get(@Req() r: any, @Param('id') id: string) {
    const ride = await this.p.visibleRide(r.user.id, id);
    const pay = await this.p.db.tx(db => db.getPaymentByRide(ride.id));
    if (!pay) throw new DomainError('NOT_FOUND', 'No payment for this ride');
    return env({ status: pay.status, amountMinor: pay.amountMinor, currency: 'INR', attempt: pay.attempt, refundedMinor: pay.refundedMinor,
      intent: ride.riderId === r.user.id && pay.status === 'REQUIRES_ACTION' ? pay.intent : null });
  }
  @Post('rides/:id/payment/retry') @Roles('RIDER')
  async retry(@Req() r: any, @Param('id') id: string) {
    const p = await this.pay.retry(id, r.user.id);
    return env({ status: p?.status, attempt: p?.attempt, intent: p?.intent ?? null });
  }
}

/** Provider callbacks. No user auth: the HMAC over the RAW body is the authentication. */
@Controller('api/v1/webhooks/payments')
export class WebhooksController {
  constructor(@Inject(PaymentService) private pay: PaymentService, @Inject('PAYMENT_PROVIDER') private provider: PaymentProvider, @Inject('RATE_LIMITERS') private rl: RateLimiters) {}
  @Post(':provider') @HttpCode(200)
  async hook(@Param('provider') name: string, @Req() req: any, @Headers('x-signature') sig?: string) {
    if (!this.rl.webhook.check(`wh:${name}`)) throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many webhook calls' }, 429);
    if (name !== this.provider.name) throw new HttpException({ code: 'NOT_FOUND', message: 'Unknown provider' }, 404);
    if (!req.rawBody) throw new HttpException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' }, 401); // fail closed: never verify a re-serialised body
    let outcome: string;
    try { outcome = await this.pay.handleWebhook(req.rawBody, sig); }
    catch (e) { if (e instanceof SignatureError) throw new HttpException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid signature' }, 401); throw e; }
    // 2xx tells the provider to stop retrying. We only withhold it when we could not place the event YET.
    if (outcome === 'UNKNOWN_REFERENCE') throw new HttpException({ code: 'RETRY_LATER', message: 'Reference not yet known' }, 503);
    return { received: true, outcome };
  }
}

/** Development only (ENABLE_DEV_TOOLS=1): acts as the customer paying in their UPI app against the FAKE provider. */
@Controller('api/v1/dev')
export class DevPaymentsController {
  constructor(@Inject('PAYMENT_PROVIDER') private provider: PaymentProvider, @Inject('DEV_WEBHOOK_URL') private url: string) {}
  @Post('fake-pay/:providerRef')
  async pay(@Param('providerRef') ref: string, @Body() b: unknown) {
    const x = parse(z.object({ outcome: z.enum(['SUCCEEDED', 'FAILED']).default('SUCCEEDED') }), b);
    if (!(this.provider instanceof FakeProvider) || !this.provider.payments.has(ref)) throw new DomainError('NOT_FOUND', 'Unknown payment');
    const e = this.provider.settle(ref, x.outcome);
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': e.signature }, body: e.rawBody });
    return env({ webhookStatus: res.status, webhook: await res.json().catch(() => null) });
  }
}

const STAFF: Role[] = ['SUPPORT', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPER_ADMIN'];
const OPS: Role[] = ['OPS_ADMIN', 'SUPER_ADMIN'];
const FIN: Role[] = ['FINANCE_ADMIN', 'SUPER_ADMIN'];
const RIDE_STATUS = z.enum(['REQUESTED', 'SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
const search = z.object({ q: z.string().trim().min(3).max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
/** Staff may see full phone numbers only if their job requires calling people (ops, super admin). */
const fullPii = (role: string) => OPS.includes(role as Role);

/**
 * Staff console API. Role matrix:
 *   SUPPORT          read rides/drivers (phones masked)
 *   OPS_ADMIN        + approve/reject/suspend/reinstate drivers, full phones, audit log
 *   FINANCE_ADMIN    read rides (masked) + refunds, reconciliation, audit log
 *   SUPER_ADMIN      everything
 */
@Controller('api/v1/admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(Platform) private p: Platform, @Inject(PaymentService) private pay: PaymentService) {}
  @Get('me') @Roles(...STAFF) me(@Req() r: any) { return env({ id: r.user.id, role: r.user.role }); }
  @Get('summary') @Roles(...STAFF) async summary() { return env(await this.p.db.tx(db => db.summaryCounts())); }

  @Get('drivers') @Roles('SUPPORT', ...OPS)
  async drivers(@Req() r: any, @Query() q: unknown) {
    const x = parse(search.extend({ verification: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), q);
    const rows = await this.p.db.tx(db => db.listDriverRows({ verification: x.verification, q: x.q }, x.limit));
    return env(rows.map(d => ({ ...d, phone: fullPii(r.user.role) ? d.phone : maskPhone(d.phone) })));
  }
  @Post('drivers/:id/review') @Roles(...OPS)
  async review(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().min(3).max(500) }), b);
    return env(await this.p.db.tx(async db => {
      const d = await db.getProfile(id); if (!d) throw new DomainError('NOT_FOUND', 'Driver not found');
      await db.addAudit({ actorId: r.user.id, action: 'DRIVER_REVIEW', targetId: id, reason: x.reason, before: d.verification, after: x.decision, at: this.p.now() });
      await db.saveProfile({ ...d, verification: x.decision }); // audit + change commit together
      return { verification: x.decision };
    }));
  }
  @Post('drivers/:id/suspend') @Roles(...OPS)
  async suspend(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ reason: z.string().min(3).max(500) }), b);
    await this.p.db.tx(async db => {
      const u = await db.getUser(id); if (!u) throw new DomainError('NOT_FOUND', 'User not found');
      await db.addAudit({ actorId: r.user.id, action: 'SUSPEND', targetId: id, reason: x.reason, before: u.status, after: 'SUSPENDED', at: this.p.now() });
      await db.setUserStatus(id, 'SUSPENDED'); await db.revokeUserSessions(id); // audit, status and session revocation commit together
    });
    await this.p.dispatch.goOffline(id);
    return env({ status: 'SUSPENDED' });
  }
  /** Lifts a suspension. The person must sign in again and go online themselves; nothing is restored automatically. */
  @Post('users/:id/reinstate') @Roles(...OPS)
  async reinstate(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ reason: z.string().min(3).max(500) }), b);
    await this.p.db.tx(async db => {
      const u = await db.getUser(id); if (!u) throw new DomainError('NOT_FOUND', 'User not found');
      if (u.status !== 'SUSPENDED') throw new DomainError('INVALID_TRANSITION', 'Account is not suspended');
      await db.addAudit({ actorId: r.user.id, action: 'REINSTATE', targetId: id, reason: x.reason, before: u.status, after: 'ACTIVE', at: this.p.now() });
      await db.setUserStatus(id, 'ACTIVE');
    });
    return env({ status: 'ACTIVE' });
  }

  @Get('rides') @Roles(...STAFF)
  async rides(@Req() r: any, @Query() q: unknown) {
    const x = parse(search.extend({ status: RIDE_STATUS.optional() }), q);
    const rows = await this.p.db.tx(db => db.searchRides({ status: x.status, q: x.q }, x.limit));
    return env(rows.map(v => ({ ...v, riderPhone: fullPii(r.user.role) ? v.riderPhone : maskPhone(v.riderPhone), driverPhone: fullPii(r.user.role) ? v.driverPhone : maskPhone(v.driverPhone) })));
  }
  @Get('rides/:id') @Roles(...STAFF)
  async ride(@Req() r: any, @Param('id') id: string) { return env(await this.p.adminRideDetail(r.user.id, fullPii(r.user.role), id)); }

  @Post('payments/:rideId/refund') @Roles(...FIN)
  async refund(@Req() r: any, @Param('rideId') rideId: string, @Body() b: unknown) {
    const x = parse(z.object({ amountMinor: z.number().int().positive(), reason: z.string().min(3).max(500) }), b);
    const f = await this.pay.requestRefund(r.user.id, rideId, x.amountMinor, x.reason);
    return env({ refundId: f.id, status: f.status, amountMinor: f.amountMinor });
  }
  @Get('reconciliation/findings') @Roles(...FIN) async findings() { return env(await this.p.db.tx(db => db.listFindings())); }
  @Post('reconciliation/run') @Roles(...FIN) async reconcile() { return env(await this.pay.reconcile(0)); }
  @Post('reconciliation/findings/:id/resolve') @Roles(...FIN)
  async resolve(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ note: z.string().trim().min(5).max(1000) }), b);
    await this.p.db.tx(async db => {
      if (!(await db.resolveFinding(id, r.user.id, x.note, this.p.now()))) throw new DomainError('INVALID_TRANSITION', 'Finding not found or already resolved');
      await db.addAudit({ actorId: r.user.id, action: 'FINDING_RESOLVED', targetId: id, reason: x.note, before: 'OPEN', after: 'RESOLVED', at: this.p.now() });
    });
    return env({ status: 'RESOLVED' });
  }
  @Get('audit-logs') @Roles(...OPS, 'FINANCE_ADMIN') async audit() { return env((await this.p.db.tx(db => db.listAudit())).slice(-300).reverse()); }

  /** ADM-06: List SOS incidents, optionally filtered by status. */
  @Get('safety/incidents') @Roles(...OPS)
  async sosIncidents(@Query() q: unknown) {
    const x = parse(z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional() }), q);
    return env(await this.p.db.tx(db => db.listSosIncidents(x.status ? { status: x.status } : undefined)));
  }

  /** ADM-06: Resolve an SOS incident with a note. */
  @Post('safety/incidents/:id/resolve') @Roles(...OPS)
  async resolveSos(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const x = parse(z.object({ note: z.string().trim().min(5).max(1000) }), b);
    await this.p.db.tx(async db => {
      if (!(await db.resolveSosIncident(id, r.user.id, x.note, this.p.now()))) throw new DomainError('INVALID_TRANSITION', 'Incident not found or already resolved');
      await db.addAudit({ actorId: r.user.id, action: 'SOS_RESOLVED', targetId: id, reason: x.note, before: 'OPEN', after: 'RESOLVED', at: this.p.now() });
    });
    return env({ status: 'RESOLVED' });
  }
}
