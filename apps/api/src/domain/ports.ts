import { Ride } from './rideStateMachine';
import { FareBreakdown } from './fare';

export type LL = { lat: number; lng: number };
export interface DriverState {
  id: string; approved: boolean; online: boolean; vehicleCategory: string; zoneId: string;
  lat: number; lng: number; lastLocationAt: number; activeRideId: string | null;
}
export interface Offer {
  id: string; rideId: string; driverId: string; sequenceNumber: number; dispatchAttemptId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'INVALIDATED';
  createdAt: number; expiresAt: number; respondedAt?: number;
}
export interface RideRequest { riderId: string; zoneId: string; category: string; pickup: LL; idempotencyKey: string; fareQuoteId?: string; paymentMethod?: 'CASH' | 'UPI' }
export interface RideMeta { fareQuoteId: string | null; paymentMethod: 'CASH' | 'UPI' | null; finalFareMinor: number | null }
export interface OutboxEvent { id: string; type: string; aggregateId: string; payload: any }
export interface Quote { id: string; riderId: string; zoneId: string; category: string; pickup: LL; destination: LL; fare: FareBreakdown; expiresAt: number }
export interface DriverProfile { userId: string; verification: 'PENDING' | 'APPROVED' | 'REJECTED'; category: string; registration: string; lastSeq: number }
export interface AuditEntry { actorId: string; action: string; targetId: string; reason: string; before: unknown; after: unknown; at: number }
export interface LedgerLine { account: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: number }

export type Role = 'RIDER' | 'DRIVER' | 'SUPPORT' | 'OPS_ADMIN' | 'FINANCE_ADMIN' | 'SUPER_ADMIN';
export interface UserRec { id: string; phone: string; role: Role; status: 'ACTIVE' | 'SUSPENDED' }
export interface OtpRec { phone: string; hash: string; expires: number; attempts: number; used: boolean; createdAt: number }
export interface SessionRec { userId: string; revoked: boolean; expiresAt: number }
export interface RideSummary { id: string; status: string; createdAt: number; paymentMethod: 'CASH' | 'UPI' | null; fareMinor: number | null; paymentStatus: string | null }
export interface OutboxRow extends OutboxEvent { attempts: number }

export type PaymentStatus = 'PENDING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
export interface PaymentRec { id: string; rideId: string; amountMinor: number; status: PaymentStatus; attempt: number; providerRef: string | null;
  intent: { upiUri: string; expiresAt: number } | null; refundedMinor: number; createdAt: number; updatedAt: number }
export interface RefundRec { id: string; paymentId: string; providerRef: string; amountMinor: number; reason: string; kind: 'CUSTOMER' | 'DUPLICATE_CAPTURE';
  status: 'REQUESTED' | 'SUCCEEDED' | 'FAILED'; providerRefundRef: string | null; requestedBy: string; createdAt: number }
export interface Finding { id?: string; kind: string; providerRef: string; details: unknown; status?: 'OPEN' | 'RESOLVED'; resolvedBy?: string | null; resolvedNote?: string | null; resolvedAt?: number | null }
export interface AdminDriverRow { userId: string; phone: string; registration: string; category: string; verification: string; accountStatus: string; online: boolean }
export interface AdminRideRow { id: string; status: string; createdAt: number; paymentMethod: string | null; fareMinor: number | null; paymentStatus: string | null; riderPhone: string | null; driverPhone: string | null }
export interface RideEventRow { type: string; stateVersion: number; at: number; payload: any }
export interface LedgerRow { transactionId: string; account: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: number }
export interface SummaryCounts { pendingDrivers: number; onlineDrivers: number; activeRides: number; openFindings: number; openPayments: number; openSosIncidents: number }
export interface Rating { id: string; rideId: string; fromUserId: string; toUserId: string; role: 'RIDER' | 'DRIVER'; stars: number; comment: string | null; createdAt: number }
export interface EarningsSummary { totalEarningsMinor: number; totalCommissionMinor: number; totalCancellationFeesMinor: number; ridesCompleted: number }
export interface SosIncident { id: string; rideId: string; reporterId: string; reporterRole: 'RIDER' | 'DRIVER'; location: LL | null; description: string; status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'; createdAt: number; resolvedAt: number | null; resolvedBy: string | null; resolvedNote: string | null }

/** All persistence the domain needs. Every method runs inside the surrounding Db.tx. */
export interface Repo {
  // rides
  getRide(id: string, forUpdate?: boolean): Promise<Ride | undefined>;
  insertRide(ride: Ride, req: RideRequest): Promise<void>;
  /** Compare-and-set on stateVersion; throws a retryable DomainError on a lost race. */
  saveRide(prev: Ride, next: Ride): Promise<void>;
  getRideMeta(rideId: string): Promise<RideMeta | undefined>;
  setFinalFare(rideId: string, minor: number): Promise<void>;
  getRequest(rideId: string): Promise<RideRequest>;
  listRidesByRider(riderId: string): Promise<Ride[]>;
  /** Newest first, with fare and payment status, for the rider's history and for resuming an unfinished ride/payment. */
  listRideSummaries(riderId: string, limit: number): Promise<RideSummary[]>;
  /** Returns the ride id that owns this key: `newRideId` if this call claimed it, else the earlier winner. */
  claimIdempotency(key: string, newRideId: string): Promise<string>;
  // drivers & presence
  getDriver(id: string, forUpdate?: boolean): Promise<DriverState | undefined>;
  saveDriver(d: DriverState): Promise<void>;
  eligibleDrivers(req: RideRequest, freshSince: number, radiusMeters: number, exclude: string[]): Promise<DriverState[]>;
  // offers & assignments
  insertOffer(o: Offer): Promise<void>;
  getOffer(id: string, forUpdate?: boolean): Promise<Offer | undefined>;
  saveOffer(o: Offer): Promise<void>;
  offersForRide(rideId: string): Promise<Offer[]>;
  triedDrivers(rideId: string): Promise<Set<string>>;
  pendingOfferIds(): Promise<string[]>;
  pendingOffersForDriver(driverId: string): Promise<Offer[]>;
  invalidatePendingOffersForRide(rideId: string): Promise<void>;
  createAssignment(rideId: string, driverId: string): Promise<void>;
  endAssignment(rideId: string): Promise<void>;
  // outbox
  emit(type: string, aggregateId: string, payload: unknown): Promise<void>;
  listOutbox(): Promise<OutboxEvent[]>;
  /** Locks up to `limit` due PENDING events (SKIP LOCKED in Postgres) for this transaction, oldest first. */
  claimOutbox(limit: number, nowMs: number): Promise<OutboxRow[]>;
  markOutbox(id: string, status: 'DELIVERED' | 'FAILED' | 'PENDING', attempts: number, retryAtMs?: number): Promise<void>;
  // auth
  getUser(id: string): Promise<UserRec | undefined>;
  getUserByPhone(phone: string): Promise<UserRec | undefined>;
  /** Creates the user, or returns the existing one if another request won the race. */
  createUser(u: UserRec): Promise<UserRec>;
  setUserStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void>;
  getOtp(phone: string, forUpdate?: boolean): Promise<OtpRec | undefined>;
  saveOtp(o: OtpRec): Promise<void>;
  saveSession(tokenHash: string, userId: string, expiresAt: number): Promise<void>;
  getSession(tokenHash: string, forUpdate?: boolean): Promise<SessionRec | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  // quotes, profiles, audit
  saveQuote(q: Quote): Promise<void>;
  getQuote(id: string): Promise<Quote | undefined>;
  getProfile(userId: string): Promise<DriverProfile | undefined>;
  saveProfile(p: DriverProfile): Promise<void>;
  listProfiles(): Promise<DriverProfile[]>;
  addAudit(a: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  // payments
  insertPayment(p: PaymentRec): Promise<void>;
  getPayment(id: string, forUpdate?: boolean): Promise<PaymentRec | undefined>;
  getPaymentByRide(rideId: string, forUpdate?: boolean): Promise<PaymentRec | undefined>;
  savePayment(p: PaymentRec): Promise<void>;
  addAttempt(a: { providerRef: string; paymentId: string; attempt: number }): Promise<void>;
  getAttempt(providerRef: string): Promise<{ paymentId: string; attempt: number } | undefined>;
  /** True if this provider event id has never been seen (and is now recorded). */
  recordPaymentEvent(provider: string, eventId: string, type: string, providerRef: string, payload: unknown): Promise<boolean>;
  setPaymentEventOutcome(provider: string, eventId: string, outcome: string): Promise<void>;
  listPaymentEvents(): Promise<{ providerEventId: string; type: string; outcome: string }[]>;
  insertRefund(x: RefundRec): Promise<void>;
  getRefund(id: string, forUpdate?: boolean): Promise<RefundRec | undefined>;
  saveRefund(x: RefundRec): Promise<void>;
  listRefunds(paymentId: string): Promise<RefundRec[]>;
  refundsToSend(limit: number): Promise<RefundRec[]>;
  paymentsAwaitingProvider(limit: number): Promise<PaymentRec[]>;
  stalePayments(beforeMs: number, limit: number): Promise<PaymentRec[]>;
  addFinding(f: Finding): Promise<boolean>;
  /** Resolves an OPEN finding exactly once. Returns false if it does not exist or is already resolved. */
  resolveFinding(id: string, by: string, note: string, atMs: number): Promise<boolean>;
  // admin console reads
  listDriverRows(filter: { verification?: string; q?: string }, limit: number): Promise<AdminDriverRow[]>;
  searchRides(filter: { status?: string; q?: string }, limit: number): Promise<AdminRideRow[]>;
  rideEvents(rideId: string): Promise<RideEventRow[]>;
  ledgerForTransactions(ids: string[]): Promise<LedgerRow[]>;
  summaryCounts(): Promise<SummaryCounts>;
  listFindings(): Promise<Finding[]>;
  // ledger (idempotent per transactionId; throws LEDGER_UNBALANCED)
  postLedger(transactionId: string, lines: LedgerLine[]): Promise<boolean>;
  ledgerBalance(account: string): Promise<number>;
  ledgerTotals(): Promise<{ debit: number; credit: number }>;
  // ratings
  insertRating(r: Rating): Promise<void>;
  getRatingByRideAndRole(rideId: string, role: 'RIDER' | 'DRIVER'): Promise<Rating | undefined>;
  averageRating(userId: string): Promise<{ average: number; count: number }>;
  // earnings
  driverEarnings(driverId: string): Promise<EarningsSummary>;
  // safety
  insertSosIncident(s: SosIncident): Promise<void>;
  getSosIncident(id: string): Promise<SosIncident | undefined>;
  listSosIncidents(filter?: { status?: string }): Promise<SosIncident[]>;
  resolveSosIncident(id: string, by: string, note: string, atMs: number): Promise<boolean>;
}
export interface Db { tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> }
