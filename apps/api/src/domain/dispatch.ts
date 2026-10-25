import { randomUUID } from 'node:crypto';
import { DomainError } from './errors';
import { Db, DriverState, LL, Offer, Repo, RideRequest } from './ports';
import { Actor, Ride, RideCommand, transition } from './rideStateMachine';

export type { DriverState, Offer, RideRequest, OutboxEvent } from './ports';
export { Store } from './memory';

export interface Config { offerTimeoutMs: number; locationFreshnessMs: number; maxOffers: number; searchRadiusMeters?: number }
/** Pickup ETA seconds. Production: routing provider; this straight-line fallback is for when routing is unavailable. */
export type EtaFn = (driver: DriverState, pickup: LL) => number;
const fallbackEta: EtaFn = (d, p) => Math.hypot(d.lat - p.lat, d.lng - p.lng) * 111_000 / 6;
const SYSTEM: Actor = { kind: 'SYSTEM', id: 'dispatcher' };

/**
 * Dispatch over a Db. Lock order is always offer -> ride -> driver so concurrent transactions cannot deadlock.
 * Correctness comes from row locks + the database constraints, not from process memory.
 */
export class DispatchService {
  constructor(private db: Db, private cfg: Config, private now: () => number = Date.now, private eta: EtaFn = fallbackEta) {}

  private async apply(r: Repo, ride: Ride, cmd: RideCommand, actor: Actor, driverId?: string) {
    const next = transition(ride, cmd, actor, driverId);
    await r.saveRide(ride, next);
    await r.emit('ride.status.changed', ride.id, { status: next.status, stateVersion: next.stateVersion, riderId: next.riderId, driverId: next.driverId });
    return next;
  }

  /** RDR-04 / AC-03: one logical booking per (rider, idempotencyKey), even under concurrent submission. */
  createRide(req: RideRequest): Promise<Ride> {
    return this.db.tx(async r => {
      const id = randomUUID();
      const winner = await r.claimIdempotency(`${req.riderId}:${req.idempotencyKey}`, id);
      if (winner !== id) return (await r.getRide(winner))!;
      await r.insertRide({ id, riderId: req.riderId, driverId: null, status: 'REQUESTED', stateVersion: 1 }, req);
      const searching = await this.apply(r, (await r.getRide(id))!, 'START_SEARCH', SYSTEM);
      await this.offerNext(r, searching);
      return (await r.getRide(id))!;
    });
  }

  /** Caller holds the ride lock. Offers to the best untried candidate, or expires the search. */
  private async offerNext(r: Repo, ride: Ride) {
    if (ride.status !== 'SEARCHING') return;
    const req = await r.getRequest(ride.id); const tried = await r.triedDrivers(ride.id);
    const candidates = tried.size < this.cfg.maxOffers
      ? await r.eligibleDrivers(req, this.now() - this.cfg.locationFreshnessMs, this.cfg.searchRadiusMeters ?? 10_000, [...tried]) : [];
    candidates.sort((a, b) => this.eta(a, req.pickup) - this.eta(b, req.pickup) || a.id.localeCompare(b.id));
    const next = candidates[0];
    if (!next) { await this.apply(r, ride, 'EXPIRE', SYSTEM); return; }
    const offer: Offer = { id: randomUUID(), rideId: ride.id, driverId: next.id, sequenceNumber: tried.size + 1, dispatchAttemptId: ride.id,
      status: 'PENDING', createdAt: this.now(), expiresAt: this.now() + this.cfg.offerTimeoutMs };
    await r.insertOffer(offer);
    await r.emit('ride.offer.created', ride.id, { offerId: offer.id, driverId: next.id, expiresAt: offer.expiresAt });
  }

  /** AC-01 / AC-02: atomic claim. A refusal caused by expiry is committed (offer -> EXPIRED, next driver offered) and then reported. */
  async acceptOffer(offerId: string, driverId: string): Promise<Ride> {
    const out = await this.db.tx(async (r): Promise<{ ride: Ride } | { err: DomainError }> => {
      const offer = await r.getOffer(offerId, true);
      if (!offer || offer.driverId !== driverId) throw new DomainError('NOT_FOUND', 'Offer not found');
      if (offer.status !== 'PENDING') throw new DomainError('OFFER_NOT_PENDING', 'Offer is no longer pending');
      const ride = (await r.getRide(offer.rideId, true))!;
      if (this.now() >= offer.expiresAt) {
        await r.saveOffer({ ...offer, status: 'EXPIRED', respondedAt: this.now() });
        await this.offerNext(r, ride);
        return { err: new DomainError('OFFER_EXPIRED', 'This ride offer has expired.') };
      }
      if (ride.status !== 'SEARCHING') throw new DomainError('RIDE_NOT_SEARCHING', 'Ride already assigned or closed');
      const d = await r.getDriver(driverId, true);
      if (!d || !d.approved || !d.online || d.activeRideId) throw new DomainError('DRIVER_BUSY', 'Driver not available');
      await r.saveOffer({ ...offer, status: 'ACCEPTED', respondedAt: this.now() });
      await r.saveDriver({ ...d, activeRideId: ride.id });
      await r.createAssignment(ride.id, driverId);
      const next = await this.apply(r, ride, 'ASSIGN', SYSTEM, driverId);
      await r.emit('ride.assigned', ride.id, { driverId, riderId: ride.riderId });
      return { ride: next };
    });
    if ('err' in out) throw out.err;
    return out.ride;
  }

  rejectOffer(offerId: string, driverId: string): Promise<void> {
    return this.db.tx(async r => {
      const offer = await r.getOffer(offerId, true);
      if (!offer || offer.driverId !== driverId) throw new DomainError('NOT_FOUND', 'Offer not found');
      if (offer.status !== 'PENDING') throw new DomainError('OFFER_NOT_PENDING', 'Offer is no longer pending');
      const ride = (await r.getRide(offer.rideId, true))!;
      await r.saveOffer({ ...offer, status: 'REJECTED', respondedAt: this.now() });
      await this.offerNext(r, ride);
    });
  }

  /** Closes one pending offer if it has expired or its driver went offline, then advances the sequence. */
  private settle(offerId: string, force?: 'DRIVER_OFFLINE'): Promise<void> {
    return this.db.tx(async r => {
      const offer = await r.getOffer(offerId, true);
      if (!offer || offer.status !== 'PENDING') return;
      const expired = this.now() >= offer.expiresAt;
      const offline = force ? true : !(await r.getDriver(offer.driverId))?.online;
      if (!expired && !offline) return;
      const ride = (await r.getRide(offer.rideId, true))!;
      await r.saveOffer({ ...offer, status: expired ? 'EXPIRED' : 'INVALIDATED', respondedAt: this.now() });
      if (!expired) await r.emit('ride.offer.invalidated', offer.rideId, { offerId, reason: 'DRIVER_OFFLINE', driverId: offer.driverId });
      await this.offerNext(r, ride);
    });
  }

  /** Worker tick (safe to run concurrently from several workers). */
  async sweep(): Promise<void> {
    for (const id of await this.db.tx(r => r.pendingOfferIds())) await this.settle(id);
  }

  /** AC-11: the offline flag commits first, so a later accept fails; then outstanding offers are invalidated. */
  async goOffline(driverId: string): Promise<void> {
    await this.db.tx(async r => { const d = await r.getDriver(driverId, true); if (d) await r.saveDriver({ ...d, online: false }); });
    for (const o of await this.db.tx(r => r.pendingOffersForDriver(driverId))) await this.settle(o.id, 'DRIVER_OFFLINE');
  }

  /** Commands go through the state machine. `finalize` runs in the SAME transaction (e.g. fare + ledger on completion). */
  command(rideId: string, cmd: RideCommand, actor: Actor, finalize?: (r: Repo, ride: Ride) => Promise<void>): Promise<Ride> {
    return this.db.tx(async r => {
      const ride = await r.getRide(rideId, true); if (!ride) throw new DomainError('NOT_FOUND', 'Ride not found');
      const next = await this.apply(r, ride, cmd, actor);
      if ((next.status === 'COMPLETED' || next.status === 'CANCELLED') && next.driverId) {
        const d = await r.getDriver(next.driverId, true);
        if (d?.activeRideId === rideId) await r.saveDriver({ ...d, activeRideId: null });
        await r.endAssignment(rideId);
      }
      if (next.status === 'CANCELLED') {
        // Tell every driver holding a live offer that it is gone, so their screen does not keep showing a dead request.
        for (const o of (await r.offersForRide(rideId)).filter(x => x.status === 'PENDING')) await r.emit('ride.offer.invalidated', rideId, { offerId: o.id, reason: 'RIDE_CANCELLED', driverId: o.driverId });
        await r.invalidatePendingOffersForRide(rideId);
      }
      if (finalize) await finalize(r, next);
      return next;
    });
  }
}
