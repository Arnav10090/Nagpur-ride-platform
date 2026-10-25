import { randomUUID } from 'node:crypto';
import type { AdminDriverRow, AdminRideRow, RideEventRow, LedgerRow, SummaryCounts } from './ports';
import { DomainError } from './errors';
import { Ledger } from './ledger';
import { Ride } from './rideStateMachine';
import { RideSummary, PaymentRec, RefundRec, Finding, OtpRec, OutboxRow, SessionRec, UserRec, AuditEntry, Db, DriverProfile, DriverState, LedgerLine, Offer, OutboxEvent, Quote, Repo, RideMeta, RideRequest, Rating, EarningsSummary, SosIncident } from './ports';

const meters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = (x: number) => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2));
};

/** In-memory Repo + Db for fast tests/dev. Transactions are serialised but NOT rolled back on error (Postgres does that). */
export class Store implements Repo, Db {
  rides = new Map<string, Ride>(); drivers = new Map<string, DriverState>(); offers = new Map<string, Offer>();
  outbox: OutboxEvent[] = []; quotes = new Map<string, Quote>(); profiles = new Map<string, DriverProfile>();
  audit: AuditEntry[] = []; ledger = new Ledger();
  private events: { rideId: string; type: string; stateVersion: number; at: number; payload: any }[] = []; private created = new Map<string, number>(); private idem = new Map<string, string>(); private reqs = new Map<string, RideRequest>(); private meta = new Map<string, RideMeta>();
  private assignments: { rideId: string; driverId: string; status: 'ACTIVE' | 'ENDED' }[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this)); this.tail = run.catch(() => undefined); return run;
  }
  async getRide(id: string) { return this.rides.get(id); }
  async insertRide(ride: Ride, req: RideRequest) {
    this.rides.set(ride.id, ride); this.reqs.set(ride.id, req); this.created.set(ride.id, Date.now());
    this.meta.set(ride.id, { fareQuoteId: req.fareQuoteId ?? null, paymentMethod: req.paymentMethod ?? null, finalFareMinor: null });
  }
  async saveRide(prev: Ride, next: Ride) {
    if (this.rides.get(prev.id)?.stateVersion !== prev.stateVersion) throw new DomainError('INVALID_TRANSITION', 'Concurrent modification', true);
    this.rides.set(next.id, next); this.events.push({ rideId: next.id, type: `STATE_${next.status}`, stateVersion: next.stateVersion, at: Date.now(), payload: { from: prev.status } });
  }
  async getRideMeta(id: string) { return this.meta.get(id); }
  async setFinalFare(id: string, minor: number) { this.meta.get(id)!.finalFareMinor = minor; }
  async getRequest(id: string) { return this.reqs.get(id)!; }
  async listRidesByRider(riderId: string) { return [...this.rides.values()].filter(r => r.riderId === riderId); }
  async listRideSummaries(riderId: string, limit: number): Promise<RideSummary[]> {
    return [...this.rides.values()].filter(r => r.riderId === riderId).map(r => {
      const m = this.meta.get(r.id); const q = m?.fareQuoteId ? this.quotes.get(m.fareQuoteId) : undefined; const pay = [...this.pays.values()].find(x => x.rideId === r.id);
      return { id: r.id, status: r.status, createdAt: this.created.get(r.id) ?? 0, paymentMethod: m?.paymentMethod ?? null, fareMinor: m?.finalFareMinor ?? q?.fare.totalMinor ?? null, paymentStatus: pay?.status ?? null };
    }).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async claimIdempotency(key: string, id: string) { const e = this.idem.get(key); if (e) return e; this.idem.set(key, id); return id; }

  async getDriver(id: string) { const d = this.drivers.get(id); return d && { ...d }; }
  async saveDriver(d: DriverState) { this.drivers.set(d.id, { ...d }); }
  async eligibleDrivers(req: RideRequest, since: number, radius: number, exclude: string[]) {
    return [...this.drivers.values()].filter(d => d.approved && d.online && !d.activeRideId && d.zoneId === req.zoneId
      && d.vehicleCategory === req.category && d.lastLocationAt >= since && !exclude.includes(d.id) && meters(d, req.pickup) <= radius).map(d => ({ ...d }));
  }
  async insertOffer(o: Offer) { this.offers.set(o.id, { ...o }); }
  async getOffer(id: string) { const o = this.offers.get(id); return o && { ...o }; }
  async saveOffer(o: Offer) { this.offers.set(o.id, { ...o }); }
  async offersForRide(rideId: string) { return [...this.offers.values()].filter(o => o.rideId === rideId).sort((a, b) => a.sequenceNumber - b.sequenceNumber); }
  async triedDrivers(rideId: string) { return new Set((await this.offersForRide(rideId)).map(o => o.driverId)); }
  async pendingOfferIds() { return [...this.offers.values()].filter(o => o.status === 'PENDING').map(o => o.id); }
  async pendingOffersForDriver(driverId: string) { return [...this.offers.values()].filter(o => o.driverId === driverId && o.status === 'PENDING'); }
  async invalidatePendingOffersForRide(rideId: string) { for (const o of this.offers.values()) if (o.rideId === rideId && o.status === 'PENDING') o.status = 'INVALIDATED'; }
  async createAssignment(rideId: string, driverId: string) {
    if (this.assignments.some(a => a.status === 'ACTIVE' && (a.rideId === rideId || a.driverId === driverId))) throw new DomainError('DRIVER_BUSY', 'Active assignment exists');
    this.assignments.push({ rideId, driverId, status: 'ACTIVE' });
  }
  async endAssignment(rideId: string) { for (const a of this.assignments) if (a.rideId === rideId) a.status = 'ENDED'; }
  async emit(type: string, aggregateId: string, payload: unknown) { this.outbox.push({ id: randomUUID(), type, aggregateId, payload }); }
  async listOutbox() { return [...this.outbox]; }
  private ob = new Map<string, { status: string; attempts: number; at: number }>();
  async claimOutbox(limit: number, now: number): Promise<OutboxRow[]> {
    const due = this.outbox.filter(e => { const m = this.ob.get(e.id) ?? { status: 'PENDING', attempts: 0, at: 0 }; return m.status === 'PENDING' && m.at <= now; });
    return due.slice(0, limit).map(e => ({ ...e, attempts: this.ob.get(e.id)?.attempts ?? 0 }));
  }
  async markOutbox(id: string, status: string, attempts: number, retryAt = 0) { this.ob.set(id, { status, attempts, at: retryAt }); }

  private users = new Map<string, UserRec>(); private otps = new Map<string, OtpRec>(); private sessions = new Map<string, SessionRec>();
  async getUser(id: string) { const u = this.users.get(id); return u && { ...u }; }
  async getUserByPhone(phone: string) { const u = [...this.users.values()].find(x => x.phone === phone); return u && { ...u }; }
  async createUser(u: UserRec) { return (await this.getUserByPhone(u.phone)) ?? (this.users.set(u.id, { ...u }), { ...u }); }
  async setUserStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') { this.users.get(id)!.status = status; }
  async getOtp(phone: string) { const o = this.otps.get(phone); return o && { ...o }; }
  async saveOtp(o: OtpRec) { this.otps.set(o.phone, { ...o }); }
  async saveSession(h: string, userId: string, expiresAt: number) { this.sessions.set(h, { userId, revoked: false, expiresAt }); }
  async getSession(h: string) { const s = this.sessions.get(h); return s && { ...s }; }
  async revokeSession(h: string) { const s = this.sessions.get(h); if (s) s.revoked = true; }
  async revokeUserSessions(userId: string) { for (const s of this.sessions.values()) if (s.userId === userId) s.revoked = true; }

  private pays = new Map<string, PaymentRec>(); private attempts = new Map<string, { paymentId: string; attempt: number }>();
  private pevents = new Map<string, { providerEventId: string; type: string; outcome: string }>(); private refunds = new Map<string, RefundRec>(); private findings = new Map<string, Finding>();
  async insertPayment(p: PaymentRec) { if ([...this.pays.values()].some(x => x.rideId === p.rideId)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Payment exists'); this.pays.set(p.id, { ...p }); }
  async getPayment(id: string) { const p = this.pays.get(id); return p && { ...p }; }
  async getPaymentByRide(rideId: string) { const p = [...this.pays.values()].find(x => x.rideId === rideId); return p && { ...p }; }
  async savePayment(p: PaymentRec) {
    const o = this.pays.get(p.id); if (o && o.amountMinor !== p.amountMinor) throw new DomainError('INVALID_TRANSITION', 'amount immutable');
    if (p.refundedMinor > p.amountMinor || p.refundedMinor < 0) throw new DomainError('INVALID_TRANSITION', 'refund exceeds payment');
    this.pays.set(p.id, { ...p });
  }
  async addAttempt(a: { providerRef: string; paymentId: string; attempt: number }) { this.attempts.set(a.providerRef, { paymentId: a.paymentId, attempt: a.attempt }); }
  async getAttempt(ref: string) { return this.attempts.get(ref); }
  async recordPaymentEvent(provider: string, id: string, type: string) { const k = provider + ':' + id; if (this.pevents.has(k)) return false; this.pevents.set(k, { providerEventId: id, type, outcome: 'RECEIVED' }); return true; }
  async setPaymentEventOutcome(provider: string, id: string, outcome: string) { this.pevents.get(provider + ':' + id)!.outcome = outcome; }
  async listPaymentEvents() { return [...this.pevents.values()]; }
  async insertRefund(x: RefundRec) { this.refunds.set(x.id, { ...x }); }
  async getRefund(id: string) { const x = this.refunds.get(id); return x && { ...x }; }
  async saveRefund(x: RefundRec) { this.refunds.set(x.id, { ...x }); }
  async listRefunds(paymentId: string) { return [...this.refunds.values()].filter(x => x.paymentId === paymentId).map(x => ({ ...x })); }
  async refundsToSend(limit: number) { return [...this.refunds.values()].filter(x => x.status === 'REQUESTED' && !x.providerRefundRef).slice(0, limit).map(x => ({ ...x })); }
  async paymentsAwaitingProvider(limit: number) { return [...this.pays.values()].filter(p => p.status === 'PENDING' && !p.providerRef).slice(0, limit).map(p => ({ ...p })); }
  async stalePayments(before: number, limit: number) { return [...this.pays.values()].filter(p => (p.status === 'PENDING' || p.status === 'REQUIRES_ACTION') && p.providerRef && p.updatedAt < before).slice(0, limit).map(p => ({ ...p })); }
  async resolveFinding(id: string, by: string, note: string, at: number) {
    const f = [...this.findings.values()].find(x => x.id === id); if (!f || f.status !== 'OPEN') return false;
    f.status = 'RESOLVED'; f.resolvedBy = by; f.resolvedNote = note; f.resolvedAt = at; return true;
  }
  async listDriverRows(filter: { verification?: string; q?: string }, limit: number): Promise<AdminDriverRow[]> {
    const q = filter.q?.toLowerCase();
    return [...this.profiles.values()].map(p => { const u = this.users.get(p.userId); return { userId: p.userId, phone: u?.phone ?? '', registration: p.registration, category: p.category, verification: p.verification, accountStatus: u?.status ?? 'UNKNOWN', online: !!this.drivers.get(p.userId)?.online }; })
      .filter(r => (!filter.verification || r.verification === filter.verification) && (!q || r.phone.endsWith(q) || r.registration.toLowerCase().includes(q))).slice(0, limit);
  }
  async searchRides(filter: { status?: string; q?: string }, limit: number): Promise<AdminRideRow[]> {
    const q = filter.q?.toLowerCase();
    return [...this.rides.values()].map(r => {
      const m = this.meta.get(r.id); const qt = m?.fareQuoteId ? this.quotes.get(m.fareQuoteId) : undefined; const pay = [...this.pays.values()].find(x => x.rideId === r.id);
      return { id: r.id, status: r.status, createdAt: this.created.get(r.id) ?? 0, paymentMethod: m?.paymentMethod ?? null, fareMinor: m?.finalFareMinor ?? qt?.fare.totalMinor ?? null, paymentStatus: pay?.status ?? null,
        riderPhone: this.users.get(r.riderId)?.phone ?? null, driverPhone: r.driverId ? this.users.get(r.driverId)?.phone ?? null : null };
    }).filter(r => (!filter.status || r.status === filter.status) && (!q || r.id.toLowerCase().startsWith(q) || !!r.riderPhone?.endsWith(q) || !!r.driverPhone?.endsWith(q)))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async rideEvents(rideId: string): Promise<RideEventRow[]> { return this.events.filter(e => e.rideId === rideId).map(e => ({ type: e.type, stateVersion: e.stateVersion, at: e.at, payload: e.payload })); }
  async ledgerForTransactions(ids: string[]): Promise<LedgerRow[]> { return this.ledger.all().filter(e => ids.includes(e.transactionId)).map(e => ({ transactionId: e.transactionId, account: e.account, direction: e.direction, amountMinor: e.amountMinor })); }
  async summaryCounts(): Promise<SummaryCounts> {
    return { pendingDrivers: [...this.profiles.values()].filter(p => p.verification === 'PENDING').length, onlineDrivers: [...this.drivers.values()].filter(d => d.online).length,
      activeRides: [...this.rides.values()].filter(r => !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(r.status)).length, openFindings: [...this.findings.values()].filter(f => f.status === 'OPEN').length,
      openPayments: [...this.pays.values()].filter(p => p.status === 'PENDING' || p.status === 'REQUIRES_ACTION').length, openSosIncidents: [...this.sosIncidents.values()].filter(s => s.status === 'OPEN').length };
  }
  async addFinding(f: Finding) { const k = f.kind + ':' + f.providerRef; if (this.findings.has(k)) return false; this.findings.set(k, { ...f, id: randomUUID(), status: 'OPEN' }); return true; }
  async listFindings() { return [...this.findings.values()]; }

  async saveQuote(q: Quote) { this.quotes.set(q.id, q); }
  async getQuote(id: string) { return this.quotes.get(id); }
  async getProfile(id: string) { const p = this.profiles.get(id); return p && { ...p }; }
  async saveProfile(p: DriverProfile) {
    for (const o of this.profiles.values()) if (o.userId !== p.userId && o.registration === p.registration) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Registration already in use');
    this.profiles.set(p.userId, { ...p });
  }
  async listProfiles() { return [...this.profiles.values()].map(p => ({ ...p })); }
  async addAudit(a: AuditEntry) { this.audit.push(a); }
  async listAudit() { return [...this.audit]; }
  async postLedger(id: string, lines: LedgerLine[]) { return this.ledger.post(id, lines); }
  async ledgerBalance(account: string) { return this.ledger.balance(account); }
  async ledgerTotals() { return this.ledger.totals(); }

  private ratings = new Map<string, Rating>();
  async insertRating(r: Rating) { this.ratings.set(r.id, { ...r }); }
  async getRatingByRideAndRole(rideId: string, role: 'RIDER' | 'DRIVER') {
    return [...this.ratings.values()].find(r => r.rideId === rideId && r.role === role);
  }
  async averageRating(userId: string) {
    const ratings = [...this.ratings.values()].filter(r => r.toUserId === userId);
    if (ratings.length === 0) return { average: 0, count: 0 };
    return { average: ratings.reduce((sum, r) => sum + r.stars, 0) / ratings.length, count: ratings.length };
  }
  async driverEarnings(driverId: string): Promise<EarningsSummary> {
    const completed = [...this.rides.values()].filter(r => r.driverId === driverId && r.status === 'COMPLETED');
    let totalEarningsMinor = 0, totalCommissionMinor = 0, totalCancellationFeesMinor = 0;
    for (const ride of completed) {
      const m = this.meta.get(ride.id);
      if (m?.finalFareMinor) totalEarningsMinor += m.finalFareMinor;
    }
    // Sum driver_payable credits from ledger
    const allEntries = this.ledger.all();
    for (const e of allEntries) {
      if (e.account.startsWith('driver_payable:') && e.direction === 'CREDIT') {
        const rideId = e.account.split(':')[1]!;
        const ride = this.rides.get(rideId);
        if (ride?.driverId === driverId) totalCommissionMinor += 0; // tracked separately below
      }
    }
    // Simple calculation: commission = totalFare - driverPayable
    const driverPayable = allEntries
      .filter(e => e.account.startsWith('driver_payable:') && e.direction === 'CREDIT')
      .filter(e => { const rideId = e.account.split(':')[1]!; return this.rides.get(rideId)?.driverId === driverId; })
      .reduce((sum, e) => sum + e.amountMinor, 0);
    totalCommissionMinor = totalEarningsMinor - driverPayable;
    // Cancellation fees
    const cancelFees = allEntries
      .filter(e => e.account.startsWith('rider_cancellation_fee:') && e.direction === 'DEBIT')
      .filter(e => { const rideId = e.account.split(':')[1]!; return this.rides.get(rideId)?.driverId === driverId; })
      .reduce((sum, e) => sum + e.amountMinor, 0);
    totalCancellationFeesMinor = cancelFees;
    return { totalEarningsMinor: driverPayable + cancelFees, totalCommissionMinor, totalCancellationFeesMinor: cancelFees, ridesCompleted: completed.length };
  }

  private sosIncidents = new Map<string, SosIncident>();
  async insertSosIncident(s: SosIncident) { this.sosIncidents.set(s.id, { ...s }); }
  async getSosIncident(id: string) { const s = this.sosIncidents.get(id); return s && { ...s }; }
  async listSosIncidents(filter?: { status?: string }) {
    return [...this.sosIncidents.values()].filter(s => !filter?.status || s.status === filter.status).map(s => ({ ...s }));
  }
  async resolveSosIncident(id: string, by: string, note: string, atMs: number) {
    const s = this.sosIncidents.get(id); if (!s || s.status === 'RESOLVED') return false;
    s.status = 'RESOLVED'; s.resolvedBy = by; s.resolvedNote = note; s.resolvedAt = atMs; return true;
  }
}
