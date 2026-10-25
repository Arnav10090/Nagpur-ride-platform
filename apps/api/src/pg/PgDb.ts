import type { Pool, PoolClient } from 'pg';
import type { AdminDriverRow, AdminRideRow, RideEventRow, LedgerRow, SummaryCounts } from '../domain/ports';
import { DomainError } from '../domain/errors';
import { RideSummary, PaymentRec, RefundRec, Finding, OtpRec, OutboxRow, SessionRec, UserRec, AuditEntry, Db, DriverProfile, DriverState, LedgerLine, Offer, OutboxEvent, Quote, Repo, RideMeta, RideRequest, Rating, EarningsSummary, SosIncident } from '../domain/ports';
import { Ride } from '../domain/rideStateMachine';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lock = (b?: boolean) => (b ? ' FOR UPDATE' : '');
const toRide = (x: any): Ride => ({ id: x.id, riderId: x.riderId, driverId: x.driverId, status: x.status, stateVersion: x.stateVersion });
const toDriver = (x: any): DriverState => ({ id: x.driverId, approved: x.approved, online: x.online, vehicleCategory: x.vehicleCategory, zoneId: x.zoneId,
  lat: x.lat, lng: x.lng, lastLocationAt: x.lastLocationAt.getTime(), activeRideId: x.activeRideId });
const toOffer = (x: any): Offer => ({ id: x.id, rideId: x.rideId, driverId: x.driverId, sequenceNumber: x.sequenceNumber, dispatchAttemptId: x.dispatchAttemptId,
  status: x.status, createdAt: x.createdAt.getTime(), expiresAt: x.expiresAt.getTime(), respondedAt: x.respondedAt?.getTime() });
const toPay = (x: any): PaymentRec => ({ id: x.id, rideId: x.rideId, amountMinor: x.amountMinor, status: x.status, attempt: x.attempt, providerRef: x.providerRef, intent: x.intent,
  refundedMinor: x.refundedMinor, createdAt: x.createdAt.getTime(), updatedAt: x.updatedAt.getTime() });
const toRefund = (x: any): RefundRec => ({ id: x.id, paymentId: x.paymentId, providerRef: x.providerRef, amountMinor: x.amountMinor, reason: x.reason, kind: x.kind, status: x.status,
  providerRefundRef: x.providerRefundRef, requestedBy: x.requestedBy, createdAt: x.createdAt.getTime() });
/** Escapes LIKE wildcards in staff-typed search text so '%' or '_' match literally. */
const like = (s: string) => s.replace(/[\\%_]/g, m => '\\' + m);
const toProfile = (x: any): DriverProfile => ({ userId: x.userId, verification: x.verification, category: x.category, registration: x.registrationNumber, lastSeq: x.lastSeq });

/** Translate constraint violations into the stable domain errors the API contract promises. */
function mapPgError(e: any): unknown {
  if (e instanceof DomainError) return e;
  if (e?.code === '23505') switch (e.constraint) {
    case 'ride_assignment_one_active_per_driver': return new DomainError('DRIVER_BUSY', 'Driver not available');
    case 'ride_assignment_one_active_per_ride': return new DomainError('RIDE_NOT_SEARCHING', 'Ride already assigned or closed');
    case 'Payment_rideId_key': return new DomainError('IDEMPOTENCY_CONFLICT', 'Payment already exists for ride');
    case 'driver_registration_unique': return new DomainError('IDEMPOTENCY_CONFLICT', 'Registration already in use');
    default: if (String(e.constraint).startsWith('ride_offer_')) return new DomainError('INVALID_TRANSITION', 'Concurrent dispatch conflict', true);
  }
  if (e?.code === '23514' && /ride/.test(e.message)) return new DomainError('INVALID_TRANSITION', 'Transition rejected by database', false);
  return e;
}

export class PgDb implements Db {
  constructor(public pool: Pool, private maxRetries = 3) {}
  async tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN'); const out = await fn(new PgRepo(c)); await c.query('COMMIT'); return out;
      } catch (e: any) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((e?.code === '40001' || e?.code === '40P01') && attempt < this.maxRetries) continue; // serialization failure / deadlock
        throw mapPgError(e);
      } finally { c.release(); }
    }
  }
  close() { return this.pool.end(); }
}

class PgRepo implements Repo {
  constructor(private c: PoolClient) {}
  private q(sql: string, p: unknown[] = []) { return this.c.query(sql, p); }

  async getRide(id: string, forUpdate?: boolean) {
    if (!UUID.test(id)) return undefined;
    const r = await this.q(`SELECT * FROM "Ride" WHERE id=$1${lock(forUpdate)}`, [id]); return r.rows[0] && toRide(r.rows[0]);
  }
  async insertRide(ride: Ride, req: RideRequest) {
    await this.q(`INSERT INTO "Ride"(id,"riderId","driverId",status,"stateVersion","zoneId",category,"pickupLat","pickupLng","fareQuoteId","paymentMethod")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ride.id, ride.riderId, ride.driverId, ride.status, ride.stateVersion, req.zoneId, req.category, req.pickup.lat, req.pickup.lng, req.fareQuoteId ?? null, req.paymentMethod ?? null]);
  }
  async saveRide(prev: Ride, next: Ride) {
    const r = await this.q(`UPDATE "Ride" SET status=$1,"driverId"=$2,"stateVersion"=$3 WHERE id=$4 AND "stateVersion"=$5`, [next.status, next.driverId, next.stateVersion, prev.id, prev.stateVersion]);
    if (r.rowCount !== 1) throw new DomainError('INVALID_TRANSITION', 'Concurrent modification', true);
    await this.q(`INSERT INTO "RideEvent"("rideId",type,"stateVersion",payload) VALUES($1,$2,$3,$4)`, [next.id, `STATE_${next.status}`, next.stateVersion, JSON.stringify({ from: prev.status })]);
  }
  async getRideMeta(id: string): Promise<RideMeta | undefined> {
    if (!UUID.test(id)) return undefined;
    const r = await this.q(`SELECT "fareQuoteId","paymentMethod","finalFareMinor" FROM "Ride" WHERE id=$1`, [id]); return r.rows[0];
  }
  async setFinalFare(id: string, minor: number) { await this.q(`UPDATE "Ride" SET "finalFareMinor"=$1 WHERE id=$2`, [minor, id]); }
  async getRequest(id: string): Promise<RideRequest> {
    const x = (await this.q(`SELECT * FROM "Ride" WHERE id=$1`, [id])).rows[0];
    return { riderId: x.riderId, zoneId: x.zoneId, category: x.category, pickup: { lat: x.pickupLat, lng: x.pickupLng }, idempotencyKey: '', fareQuoteId: x.fareQuoteId ?? undefined, paymentMethod: x.paymentMethod ?? undefined };
  }
  async listRidesByRider(riderId: string) { return (await this.q(`SELECT * FROM "Ride" WHERE "riderId"=$1 ORDER BY "createdAt" DESC LIMIT 100`, [riderId])).rows.map(toRide); }
  async listRideSummaries(riderId: string, limit: number): Promise<RideSummary[]> {
    const r = await this.q(`SELECT r.id,r.status,r."createdAt",r."paymentMethod",COALESCE(r."finalFareMinor",q."totalMinor") AS fare,p.status AS pstatus
      FROM "Ride" r LEFT JOIN "FareQuote" q ON q.id=r."fareQuoteId" LEFT JOIN "Payment" p ON p."rideId"=r.id WHERE r."riderId"=$1 ORDER BY r."createdAt" DESC LIMIT $2`, [riderId, limit]);
    return r.rows.map(x => ({ id: x.id, status: x.status, createdAt: x.createdAt.getTime(), paymentMethod: x.paymentMethod, fareMinor: x.fare, paymentStatus: x.pstatus }));
  }
  async claimIdempotency(key: string, newId: string) {
    const ins = await this.q(`INSERT INTO "IdempotencyRecord"(scope,key,"resourceId") VALUES('ride',$1,$2) ON CONFLICT (scope,key) DO NOTHING RETURNING "resourceId"`, [key, newId]);
    if (ins.rowCount) return newId;
    return (await this.q(`SELECT "resourceId" FROM "IdempotencyRecord" WHERE scope='ride' AND key=$1`, [key])).rows[0].resourceId;
  }

  async getDriver(id: string, forUpdate?: boolean) {
    const r = await this.q(`SELECT "driverId",approved,online,"vehicleCategory","zoneId",lat,lng,"lastLocationAt","activeRideId" FROM "DriverPresence" WHERE "driverId"=$1${lock(forUpdate)}`, [id]);
    return r.rows[0] && toDriver(r.rows[0]);
  }
  async saveDriver(d: DriverState) {
    await this.q(`INSERT INTO "DriverPresence"("driverId",approved,online,"vehicleCategory","zoneId",lat,lng,"lastLocationAt","activeRideId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT ("driverId") DO UPDATE SET approved=$2,online=$3,"vehicleCategory"=$4,"zoneId"=$5,lat=$6,lng=$7,"lastLocationAt"=$8,"activeRideId"=$9`,
      [d.id, d.approved, d.online, d.vehicleCategory, d.zoneId, d.lat, d.lng, new Date(d.lastLocationAt), d.activeRideId]);
  }
  async eligibleDrivers(req: RideRequest, since: number, radius: number, exclude: string[]) {
    // Haversine distance filter using plain lat/lng (no PostGIS required).
    // 6371000 = Earth's radius in meters. Filters by radius and sorts by distance.
    const r = await this.q(`SELECT "driverId",approved,online,"vehicleCategory","zoneId",lat,lng,"lastLocationAt","activeRideId",
        (6371000 * acos(LEAST(1.0, cos(radians($5)) * cos(radians(lat)) * cos(radians(lng) - radians($6)) + sin(radians($5)) * sin(radians(lat))))) AS dist
      FROM "DriverPresence"
      WHERE approved AND online AND "activeRideId" IS NULL AND "zoneId"=$1 AND "vehicleCategory"=$2 AND "lastLocationAt">=$3 AND "driverId" <> ALL($4::text[])
        AND (6371000 * acos(LEAST(1.0, cos(radians($5)) * cos(radians(lat)) * cos(radians(lng) - radians($6)) + sin(radians($5)) * sin(radians(lat))))) <= $7
      ORDER BY dist, "driverId" LIMIT 25`,
      [req.zoneId, req.category, new Date(since), exclude, req.pickup.lat, req.pickup.lng, radius]);
    return r.rows.map(toDriver);
  }

  async insertOffer(o: Offer) {
    await this.q(`INSERT INTO "RideOffer"(id,"rideId","driverId","sequenceNumber","dispatchAttemptId",status,"createdAt","expiresAt","respondedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, o.rideId, o.driverId, o.sequenceNumber, o.dispatchAttemptId, o.status, new Date(o.createdAt), new Date(o.expiresAt), o.respondedAt ? new Date(o.respondedAt) : null]);
  }
  async getOffer(id: string, forUpdate?: boolean) {
    if (!UUID.test(id)) return undefined;
    const r = await this.q(`SELECT * FROM "RideOffer" WHERE id=$1${lock(forUpdate)}`, [id]); return r.rows[0] && toOffer(r.rows[0]);
  }
  async saveOffer(o: Offer) { await this.q(`UPDATE "RideOffer" SET status=$1,"respondedAt"=$2 WHERE id=$3`, [o.status, o.respondedAt ? new Date(o.respondedAt) : null, o.id]); }
  async offersForRide(rideId: string) { return (await this.q(`SELECT * FROM "RideOffer" WHERE "rideId"=$1 ORDER BY "sequenceNumber"`, [rideId])).rows.map(toOffer); }
  async triedDrivers(rideId: string) { return new Set((await this.q(`SELECT "driverId" FROM "RideOffer" WHERE "rideId"=$1`, [rideId])).rows.map(x => x.driverId as string)); }
  async pendingOfferIds() { return (await this.q(`SELECT id FROM "RideOffer" WHERE status='PENDING'`)).rows.map(x => x.id as string); }
  async pendingOffersForDriver(driverId: string) { return (await this.q(`SELECT * FROM "RideOffer" WHERE "driverId"=$1 AND status='PENDING'`, [driverId])).rows.map(toOffer); }
  async invalidatePendingOffersForRide(rideId: string) { await this.q(`UPDATE "RideOffer" SET status='INVALIDATED' WHERE "rideId"=$1 AND status='PENDING'`, [rideId]); }
  async createAssignment(rideId: string, driverId: string) { await this.q(`INSERT INTO "RideAssignment"("rideId","driverId") VALUES($1,$2)`, [rideId, driverId]); }
  async endAssignment(rideId: string) { await this.q(`UPDATE "RideAssignment" SET status='ENDED',"endedAt"=now() WHERE "rideId"=$1 AND status='ACTIVE'`, [rideId]); }

  async emit(type: string, aggregateId: string, payload: unknown) { await this.q(`INSERT INTO "OutboxEvent"(type,"aggregateId",payload) VALUES($1,$2,$3)`, [type, aggregateId, JSON.stringify(payload)]); }
  async listOutbox(): Promise<OutboxEvent[]> { return (await this.q(`SELECT id,type,"aggregateId",payload FROM "OutboxEvent" ORDER BY seq`)).rows; }

  async claimOutbox(limit: number, nowMs: number): Promise<OutboxRow[]> {
    const r = await this.q(`SELECT id,type,"aggregateId",payload,attempts FROM "OutboxEvent" WHERE "deliveryStatus"='PENDING' AND ("availableAt" IS NULL OR "availableAt"<=$1) ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED`, [new Date(nowMs), limit]);
    return r.rows;
  }
  async markOutbox(id: string, status: string, attempts: number, retryAtMs?: number) {
    await this.q(`UPDATE "OutboxEvent" SET "deliveryStatus"=$2,attempts=$3,"availableAt"=$4 WHERE id=$1`, [id, status, attempts, retryAtMs ? new Date(retryAtMs) : null]);
  }
  async getUser(id: string) { if (!UUID.test(id)) return undefined; const r = await this.q(`SELECT id,phone,role,status FROM "User" WHERE id=$1`, [id]); return r.rows[0] as UserRec | undefined; }
  async getUserByPhone(phone: string) { const r = await this.q(`SELECT id,phone,role,status FROM "User" WHERE phone=$1`, [phone]); return r.rows[0] as UserRec | undefined; }
  async createUser(u: UserRec) {
    const r = await this.q(`INSERT INTO "User"(id,phone,role,status) VALUES($1,$2,$3,$4) ON CONFLICT (phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,phone,role,status`, [u.id, u.phone, u.role, u.status]);
    return r.rows[0] as UserRec;
  }
  async setUserStatus(id: string, status: string) { await this.q(`UPDATE "User" SET status=$2 WHERE id=$1`, [id, status]); }
  async getOtp(phone: string, forUpdate?: boolean): Promise<OtpRec | undefined> {
    const x = (await this.q(`SELECT * FROM "OtpChallenge" WHERE phone=$1${lock(forUpdate)}`, [phone])).rows[0];
    return x && { phone: x.phone, hash: x.hash, expires: x.expiresAt.getTime(), attempts: x.attempts, used: x.used, createdAt: x.createdAt.getTime() };
  }
  async saveOtp(o: OtpRec) {
    await this.q(`INSERT INTO "OtpChallenge"(phone,hash,"expiresAt",attempts,used,"createdAt") VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (phone) DO UPDATE SET hash=$2,"expiresAt"=$3,attempts=$4,used=$5,"createdAt"=$6`, [o.phone, o.hash, new Date(o.expires), o.attempts, o.used, new Date(o.createdAt)]);
  }
  async saveSession(h: string, userId: string, expiresAt: number) { await this.q(`INSERT INTO "Session"("tokenHash","userId","expiresAt") VALUES($1,$2,$3)`, [h, userId, new Date(expiresAt)]); }
  async getSession(h: string, forUpdate?: boolean): Promise<SessionRec | undefined> {
    const x = (await this.q(`SELECT "userId",revoked,"expiresAt" FROM "Session" WHERE "tokenHash"=$1${lock(forUpdate)}`, [h])).rows[0];
    return x && { userId: x.userId, revoked: x.revoked, expiresAt: x.expiresAt.getTime() };
  }
  async revokeSession(h: string) { await this.q(`UPDATE "Session" SET revoked=true WHERE "tokenHash"=$1`, [h]); }
  async revokeUserSessions(userId: string) { await this.q(`UPDATE "Session" SET revoked=true WHERE "userId"=$1`, [userId]); }

  async insertPayment(p: PaymentRec) {
    await this.q(`INSERT INTO "Payment"(id,"rideId","amountMinor",status,attempt,"providerRef",intent,"refundedMinor","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [p.id, p.rideId, p.amountMinor, p.status, p.attempt, p.providerRef, p.intent && JSON.stringify(p.intent), p.refundedMinor, new Date(p.createdAt), new Date(p.updatedAt)]);
  }
  async getPayment(id: string, forUpdate?: boolean) { if (!UUID.test(id)) return undefined; const r = await this.q(`SELECT * FROM "Payment" WHERE id=$1${lock(forUpdate)}`, [id]); return r.rows[0] && toPay(r.rows[0]); }
  async getPaymentByRide(rideId: string, forUpdate?: boolean) { if (!UUID.test(rideId)) return undefined; const r = await this.q(`SELECT * FROM "Payment" WHERE "rideId"=$1${lock(forUpdate)}`, [rideId]); return r.rows[0] && toPay(r.rows[0]); }
  async savePayment(p: PaymentRec) {
    await this.q(`UPDATE "Payment" SET "amountMinor"=$2,status=$3,attempt=$4,"providerRef"=$5,intent=$6,"refundedMinor"=$7,"updatedAt"=$8 WHERE id=$1`,
      [p.id, p.amountMinor, p.status, p.attempt, p.providerRef, p.intent && JSON.stringify(p.intent), p.refundedMinor, new Date(p.updatedAt)]);
  }
  async addAttempt(a: { providerRef: string; paymentId: string; attempt: number }) { await this.q(`INSERT INTO "PaymentAttempt"("providerRef","paymentId",attempt) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [a.providerRef, a.paymentId, a.attempt]); }
  async getAttempt(ref: string) { const r = await this.q(`SELECT "paymentId",attempt FROM "PaymentAttempt" WHERE "providerRef"=$1`, [ref]); return r.rows[0]; }
  async recordPaymentEvent(provider: string, id: string, type: string, ref: string, payload: unknown) {
    const r = await this.q(`INSERT INTO "PaymentEvent"(provider,"providerEventId",type,"providerRef",payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT (provider,"providerEventId") DO NOTHING`, [provider, id, type, ref, JSON.stringify(payload)]);
    return r.rowCount === 1; // a concurrent duplicate blocks on the unique index until the first commits, then gets 0
  }
  async setPaymentEventOutcome(provider: string, id: string, outcome: string) { await this.q(`UPDATE "PaymentEvent" SET outcome=$3 WHERE provider=$1 AND "providerEventId"=$2`, [provider, id, outcome]); }
  async listPaymentEvents() { return (await this.q(`SELECT "providerEventId",type,outcome FROM "PaymentEvent" ORDER BY "receivedAt","providerEventId"`)).rows; }
  async insertRefund(x: RefundRec) {
    await this.q(`INSERT INTO "Refund"(id,"paymentId","providerRef","amountMinor",reason,kind,status,"providerRefundRef","requestedBy","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [x.id, x.paymentId, x.providerRef, x.amountMinor, x.reason, x.kind, x.status, x.providerRefundRef, x.requestedBy, new Date(x.createdAt)]);
  }
  async getRefund(id: string, forUpdate?: boolean) { if (!UUID.test(id)) return undefined; const r = await this.q(`SELECT * FROM "Refund" WHERE id=$1${lock(forUpdate)}`, [id]); return r.rows[0] && toRefund(r.rows[0]); }
  async saveRefund(x: RefundRec) { await this.q(`UPDATE "Refund" SET status=$2,"providerRefundRef"=$3,"updatedAt"=now() WHERE id=$1`, [x.id, x.status, x.providerRefundRef]); }
  async listRefunds(paymentId: string) { return (await this.q(`SELECT * FROM "Refund" WHERE "paymentId"=$1 ORDER BY "createdAt"`, [paymentId])).rows.map(toRefund); }
  async refundsToSend(limit: number) { return (await this.q(`SELECT * FROM "Refund" WHERE status='REQUESTED' AND "providerRefundRef" IS NULL ORDER BY "createdAt" LIMIT $1`, [limit])).rows.map(toRefund); }
  async paymentsAwaitingProvider(limit: number) { return (await this.q(`SELECT * FROM "Payment" WHERE status='PENDING' AND "providerRef" IS NULL ORDER BY "createdAt" LIMIT $1`, [limit])).rows.map(toPay); }
  async stalePayments(before: number, limit: number) { return (await this.q(`SELECT * FROM "Payment" WHERE status IN ('PENDING','REQUIRES_ACTION') AND "providerRef" IS NOT NULL AND "updatedAt"<$1 ORDER BY "updatedAt" LIMIT $2`, [new Date(before), limit])).rows.map(toPay); }
  async addFinding(f: Finding) { const r = await this.q(`INSERT INTO "ReconciliationFinding"(kind,"providerRef",details) VALUES($1,$2,$3) ON CONFLICT (kind,"providerRef") DO NOTHING`, [f.kind, f.providerRef, JSON.stringify(f.details)]); return r.rowCount === 1; }
  async listFindings() {
    return (await this.q(`SELECT id,kind,"providerRef",details,status,"resolvedBy","resolvedNote","resolvedAt" FROM "ReconciliationFinding" ORDER BY "createdAt",kind`)).rows.map(x => ({ ...x, resolvedAt: x.resolvedAt ? x.resolvedAt.getTime() : null }));
  }
  async resolveFinding(id: string, by: string, note: string, atMs: number) {
    if (!UUID.test(id)) return false;
    const r = await this.q(`UPDATE "ReconciliationFinding" SET status='RESOLVED',"resolvedBy"=$2,"resolvedNote"=$3,"resolvedAt"=$4 WHERE id=$1 AND status='OPEN'`, [id, by, note, new Date(atMs)]); return r.rowCount === 1;
  }
  async listDriverRows(f: { verification?: string; q?: string }, limit: number): Promise<AdminDriverRow[]> {
    const r = await this.q(`SELECT dp."userId",u.phone,dp."registrationNumber" AS registration,dp.category,dp.verification,u.status AS "accountStatus",COALESCE(pr.online,false) AS online
      FROM "DriverProfile" dp JOIN "User" u ON u.id::text=dp."userId" LEFT JOIN "DriverPresence" pr ON pr."driverId"=dp."userId"
      WHERE ($1::text IS NULL OR dp.verification=$1) AND ($2::text IS NULL OR u.phone LIKE '%'||$2 OR dp."registrationNumber" ILIKE '%'||$2||'%') ORDER BY u."createdAt" DESC LIMIT $3`, [f.verification ?? null, f.q ? like(f.q) : null, limit]);
    return r.rows;
  }
  async searchRides(f: { status?: string; q?: string }, limit: number): Promise<AdminRideRow[]> {
    const r = await this.q(`SELECT r.id,r.status,r."createdAt",r."paymentMethod",COALESCE(r."finalFareMinor",qt."totalMinor") AS fare,p.status AS pstatus,ru.phone AS rphone,du.phone AS dphone
      FROM "Ride" r LEFT JOIN "FareQuote" qt ON qt.id=r."fareQuoteId" LEFT JOIN "Payment" p ON p."rideId"=r.id
      LEFT JOIN "User" ru ON ru.id::text=r."riderId" LEFT JOIN "User" du ON du.id::text=r."driverId"
      WHERE ($1::text IS NULL OR r.status=$1) AND ($2::text IS NULL OR r.id::text LIKE $2||'%' OR ru.phone LIKE '%'||$2 OR du.phone LIKE '%'||$2)
      ORDER BY r."createdAt" DESC LIMIT $3`, [f.status ?? null, f.q ? like(f.q.toLowerCase()) : null, limit]);
    return r.rows.map(x => ({ id: x.id, status: x.status, createdAt: x.createdAt.getTime(), paymentMethod: x.paymentMethod, fareMinor: x.fare, paymentStatus: x.pstatus, riderPhone: x.rphone, driverPhone: x.dphone }));
  }
  async rideEvents(rideId: string): Promise<RideEventRow[]> {
    if (!UUID.test(rideId)) return [];
    return (await this.q(`SELECT type,"stateVersion",payload,"createdAt" FROM "RideEvent" WHERE "rideId"=$1 ORDER BY "stateVersion"`, [rideId])).rows.map(x => ({ type: x.type, stateVersion: x.stateVersion, at: x.createdAt.getTime(), payload: x.payload }));
  }
  async ledgerForTransactions(ids: string[]): Promise<LedgerRow[]> {
    if (!ids.length) return [];
    return (await this.q(`SELECT "transactionId",account,direction,"amountMinor" FROM "LedgerEntry" WHERE "transactionId"=ANY($1::text[]) ORDER BY "createdAt","transactionId",direction`, [ids])).rows;
  }
  async summaryCounts(): Promise<SummaryCounts> {
    const r = await this.q(`SELECT (SELECT count(*)::int FROM "DriverProfile" WHERE verification='PENDING') AS "pendingDrivers", (SELECT count(*)::int FROM "DriverPresence" WHERE online) AS "onlineDrivers",
      (SELECT count(*)::int FROM "Ride" WHERE status NOT IN ('COMPLETED','CANCELLED','EXPIRED')) AS "activeRides", (SELECT count(*)::int FROM "ReconciliationFinding" WHERE status='OPEN') AS "openFindings",
      (SELECT count(*)::int FROM "Payment" WHERE status IN ('PENDING','REQUIRES_ACTION')) AS "openPayments",
      (SELECT count(*)::int FROM "SosIncident" WHERE status='OPEN') AS "openSosIncidents"`); return r.rows[0];
  }

  async saveQuote(x: Quote) {
    await this.q(`INSERT INTO "FareQuote"(id,"riderId","zoneId",category,pickup,destination,breakdown,"totalMinor","expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [x.id, x.riderId, x.zoneId, x.category, JSON.stringify(x.pickup), JSON.stringify(x.destination), JSON.stringify(x.fare), x.fare.totalMinor, new Date(x.expiresAt)]);
  }
  async getQuote(id: string): Promise<Quote | undefined> {
    if (!UUID.test(id)) return undefined;
    const x = (await this.q(`SELECT * FROM "FareQuote" WHERE id=$1`, [id])).rows[0];
    return x && { id: x.id, riderId: x.riderId, zoneId: x.zoneId, category: x.category, pickup: x.pickup, destination: x.destination, fare: x.breakdown, expiresAt: x.expiresAt.getTime() };
  }
  async getProfile(id: string) { const r = await this.q(`SELECT * FROM "DriverProfile" WHERE "userId"=$1`, [id]); return r.rows[0] && toProfile(r.rows[0]); }
  async saveProfile(p: DriverProfile) {
    await this.q(`INSERT INTO "DriverProfile"("userId",verification,category,"registrationNumber","lastSeq") VALUES($1,$2,$3,$4,$5)
      ON CONFLICT ("userId") DO UPDATE SET verification=$2,category=$3,"registrationNumber"=$4,"lastSeq"=$5`, [p.userId, p.verification, p.category, p.registration, p.lastSeq]);
  }
  async listProfiles() { return (await this.q(`SELECT * FROM "DriverProfile" ORDER BY "userId"`)).rows.map(toProfile); }
  async addAudit(a: AuditEntry) {
    await this.q(`INSERT INTO "AuditLog"("actorId",action,"targetId",reason,"before","after","at") VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [a.actorId, a.action, a.targetId, a.reason, JSON.stringify(a.before ?? null), JSON.stringify(a.after ?? null), new Date(a.at)]);
  }
  async listAudit(): Promise<AuditEntry[]> {
    return (await this.q(`SELECT "actorId",action,"targetId",reason,"before","after","at" FROM "AuditLog" ORDER BY seq`)).rows.map(x => ({ ...x, at: x.at.getTime() }));
  }

  async postLedger(txId: string, lines: LedgerLine[]) {
    const sum = (d: string) => lines.filter(l => l.direction === d).reduce((a, l) => a + l.amountMinor, 0);
    if (!lines.length || lines.some(l => !Number.isInteger(l.amountMinor) || l.amountMinor <= 0) || sum('DEBIT') !== sum('CREDIT'))
      throw new DomainError('LEDGER_UNBALANCED', `Transaction ${txId} is not balanced`);
    const ins = await this.q(`INSERT INTO "LedgerTransaction"(id) VALUES($1) ON CONFLICT DO NOTHING`, [txId]);
    if (!ins.rowCount) return false; // duplicate -> no second financial effect
    for (const l of lines) await this.q(`INSERT INTO "LedgerEntry"("transactionId",account,direction,"amountMinor") VALUES($1,$2,$3,$4)`, [txId, l.account, l.direction, l.amountMinor]);
    return true;
  }
  async ledgerBalance(account: string) {
    const r = await this.q(`SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END),0)::int AS b FROM "LedgerEntry" WHERE account=$1`, [account]); return r.rows[0].b;
  }
  async ledgerTotals() {
    const r = await this.q(`SELECT COALESCE(SUM("amountMinor") FILTER (WHERE direction='DEBIT'),0)::int AS d, COALESCE(SUM("amountMinor") FILTER (WHERE direction='CREDIT'),0)::int AS c FROM "LedgerEntry"`);
    return { debit: r.rows[0].d, credit: r.rows[0].c };
  }

  // ratings
  async insertRating(r: Rating) {
    await this.q(`INSERT INTO "Rating"(id,"rideId","fromUserId","toUserId",role,stars,comment,"createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, r.rideId, r.fromUserId, r.toUserId, r.role, r.stars, r.comment, r.createdAt]);
  }
  async getRatingByRideAndRole(rideId: string, role: 'RIDER' | 'DRIVER') {
    const r = await this.q(`SELECT * FROM "Rating" WHERE "rideId"=$1 AND role=$2`, [rideId, role]);
    return r.rows[0] ? { id: r.rows[0].id, rideId: r.rows[0].rideId, fromUserId: r.rows[0].fromUserId, toUserId: r.rows[0].toUserId, role: r.rows[0].role, stars: r.rows[0].stars, comment: r.rows[0].comment, createdAt: Number(r.rows[0].createdAt) } as Rating : undefined;
  }
  async averageRating(userId: string) {
    const r = await this.q(`SELECT COALESCE(AVG(stars),0) AS avg, COUNT(*)::int AS cnt FROM "Rating" WHERE "toUserId"=$1`, [userId]);
    return { average: Number(r.rows[0].avg), count: r.rows[0].cnt };
  }
  // earnings
  async driverEarnings(driverId: string): Promise<EarningsSummary> {
    const completedR = await this.q(`SELECT COUNT(*)::int AS cnt FROM "Ride" WHERE "driverId"=$1 AND status='COMPLETED'`, [driverId]);
    const payableR = await this.q(`SELECT COALESCE(SUM(e."amountMinor"),0)::int AS total FROM "LedgerEntry" e JOIN "Ride" r ON e.account = 'driver_payable:' || r.id WHERE r."driverId"=$1 AND e.direction='CREDIT'`, [driverId]);
    const cancelR = await this.q(`SELECT COALESCE(SUM(e."amountMinor"),0)::int AS total FROM "LedgerEntry" e JOIN "Ride" r ON e.account = 'rider_cancellation_fee:' || r.id WHERE r."driverId"=$1 AND e.direction='DEBIT'`, [driverId]);
    const fareR = await this.q(`SELECT COALESCE(SUM(m."finalFareMinor"),0)::int AS total FROM "RideMeta" m JOIN "Ride" r ON m."rideId"=r.id WHERE r."driverId"=$1 AND r.status='COMPLETED'`, [driverId]);
    const driverPayable = payableR.rows[0].total;
    const cancelFees = cancelR.rows[0].total;
    const totalFare = fareR.rows[0].total;
    return { totalEarningsMinor: driverPayable + cancelFees, totalCommissionMinor: totalFare - driverPayable, totalCancellationFeesMinor: cancelFees, ridesCompleted: completedR.rows[0].cnt };
  }
  // safety
  async insertSosIncident(s: SosIncident) {
    await this.q(`INSERT INTO "SosIncident"(id,"rideId","reporterId","reporterRole",lat,lng,description,status,"createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, s.rideId, s.reporterId, s.reporterRole, s.location?.lat ?? null, s.location?.lng ?? null, s.description, s.status, s.createdAt]);
  }
  async getSosIncident(id: string) {
    const r = await this.q(`SELECT * FROM "SosIncident" WHERE id=$1`, [id]);
    return r.rows[0] ? this.toSos(r.rows[0]) : undefined;
  }
  async listSosIncidents(filter?: { status?: string }) {
    const r = filter?.status
      ? await this.q(`SELECT * FROM "SosIncident" WHERE status=$1 ORDER BY "createdAt" DESC`, [filter.status])
      : await this.q(`SELECT * FROM "SosIncident" ORDER BY "createdAt" DESC`);
    return r.rows.map((x: any) => this.toSos(x));
  }
  async resolveSosIncident(id: string, by: string, note: string, atMs: number) {
    const r = await this.q(`UPDATE "SosIncident" SET status='RESOLVED', "resolvedBy"=$2, "resolvedNote"=$3, "resolvedAt"=$4 WHERE id=$1 AND status != 'RESOLVED'`, [id, by, note, atMs]);
    return (r.rowCount ?? 0) > 0;
  }
  private toSos(x: any): SosIncident {
    return { id: x.id, rideId: x.rideId, reporterId: x.reporterId, reporterRole: x.reporterRole,
      location: x.lat != null ? { lat: Number(x.lat), lng: Number(x.lng) } : null,
      description: x.description, status: x.status, createdAt: Number(x.createdAt),
      resolvedAt: x.resolvedAt ? Number(x.resolvedAt) : null, resolvedBy: x.resolvedBy, resolvedNote: x.resolvedNote };
  }
}

