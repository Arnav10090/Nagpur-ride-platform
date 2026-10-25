import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DispatchService } from '../domain/dispatch';
import { DomainError } from '../domain/errors';
import { calculateFare, PricingRule } from '../domain/fare';
import { cashRideLines, cancellationFeeLines } from '../domain/ledger';
import { Db, LL, Quote } from '../domain/ports';
import { Actor } from '../domain/rideStateMachine';
import { PaymentService } from '../domain/payments/service';
import { LiveSink } from './realtime';
import { maskPhone } from './mask';

export type { Quote, LL, DriverProfile } from '../domain/ports';

/** Placeholder pricing: real values are an open business decision (PRD 19.1). */
export const PILOT_RULE: PricingRule = { version: 1, baseMinor: 3000, perKmMinor: 1200, perMinMinor: 150, minimumMinor: 5000, cancellationFeeMinor: 2000, commissionBps: 1500 };
/** Placeholder bounding box for the pilot zone; the approved PostGIS polygon replaces this before pilot. */
export const NAGPUR_BOX = { minLat: 20.95, maxLat: 21.25, minLng: 78.95, maxLng: 79.25 };

const km = (a: LL, b: LL) => { const r = (x: number) => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  return 6371 * 2 * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2)); };

@Injectable()
export class Platform {
  constructor(@Inject('DB') public db: Db, @Inject(DispatchService) public dispatch: DispatchService, @Inject('NOW') public now: () => number, @Inject('HUB') public hub: LiveSink, @Inject(PaymentService) public payments: PaymentService) {}

  inZone(p: LL) { return p.lat >= NAGPUR_BOX.minLat && p.lat <= NAGPUR_BOX.maxLat && p.lng >= NAGPUR_BOX.minLng && p.lng <= NAGPUR_BOX.maxLng; }

  async quote(riderId: string, category: string, pickup: LL, destination: LL): Promise<Quote> {
    if (!this.inZone(pickup) || !this.inZone(destination)) throw new DomainError('FORBIDDEN', 'Pickup/destination outside service zone');
    const meters = Math.round(km(pickup, destination) * 1.3 * 1000); // road-factor fallback; routing provider replaces this
    const fare = calculateFare(PILOT_RULE, meters, Math.round(meters / 6.9));
    const q: Quote = { id: randomUUID(), riderId, zoneId: 'nagpur-pilot', category, pickup, destination, fare, expiresAt: this.now() + 5 * 60_000 };
    await this.db.tx(r => r.saveQuote(q)); return q;
  }
  async ownedQuote(riderId: string, id: string) {
    const q = await this.db.tx(r => r.getQuote(id));
    if (!q || q.riderId !== riderId) throw new DomainError('NOT_FOUND', 'Quote not found');
    if (this.now() > q.expiresAt) throw new DomainError('QUOTE_EXPIRED', 'Quote expired');
    return q;
  }
  /** Returns the ride only to its rider or assigned driver; anyone else sees 404 (AC-08). */
  async visibleRide(userId: string, rideId: string) {
    const r = await this.db.tx(x => x.getRide(rideId));
    if (!r || (r.riderId !== userId && r.driverId !== userId)) throw new DomainError('NOT_FOUND', 'Ride not found');
    return r;
  }
  /**
   * What a participant may see about a ride. Locations and fare come from the stored quote. The rider sees the assigned vehicle
   * (to recognise it); the driver receives nothing about the rider beyond the trip's pickup/destination once assigned.
   */
  async rideView(userId: string, rideId: string) {
    const ride = await this.visibleRide(userId, rideId); const isRider = ride.riderId === userId;
    return this.db.tx(async r => {
      const meta = await r.getRideMeta(ride.id); const q = meta?.fareQuoteId ? await r.getQuote(meta.fareQuoteId) : undefined;
      const prof = ride.driverId ? await r.getProfile(ride.driverId) : undefined;
      return { id: ride.id, status: ride.status, stateVersion: ride.stateVersion, paymentMethod: meta?.paymentMethod ?? null,
        pickup: q?.pickup ?? null, destination: q?.destination ?? null, estimatedFareMinor: q?.fare.totalMinor ?? null, finalFareMinor: meta?.finalFareMinor ?? null,
        vehicle: isRider && prof ? { category: prof.category, registration: prof.registration } : null };
    });
  }

  /** Everything support/finance need to resolve a ride dispute in one view. Phones are masked unless the viewer's role needs to call people. */
  async adminRideDetail(actorId: string, fullPii: boolean, rideId: string) {
    const phone = (x: string | null | undefined) => (fullPii ? x ?? null : maskPhone(x));
    return this.db.tx(async r => {
      const ride = await r.getRide(rideId); if (!ride) throw new DomainError('NOT_FOUND', 'Ride not found');
      const meta = await r.getRideMeta(ride.id); const q = meta?.fareQuoteId ? await r.getQuote(meta.fareQuoteId) : undefined;
      const rider = await r.getUser(ride.riderId); const driver = ride.driverId ? await r.getUser(ride.driverId) : undefined; const prof = ride.driverId ? await r.getProfile(ride.driverId) : undefined;
      const pay = await r.getPaymentByRide(ride.id); const refunds = pay ? await r.listRefunds(pay.id) : [];
      const txIds = [`cash-ride:${ride.id}`, ...(pay ? [`upi-capture:${pay.id}`] : []), ...refunds.map(f => (f.kind === 'CUSTOMER' ? `refund:${f.id}` : `dup-refund:${f.id}`)), ...refunds.filter(f => f.kind === 'DUPLICATE_CAPTURE').map(f => `dup-capture:${f.providerRef}`)];
      await r.addAudit({ actorId, action: 'VIEW_RIDE', targetId: ride.id, reason: 'staff ride lookup', before: null, after: null, at: this.now() });
      return {
        id: ride.id, status: ride.status, stateVersion: ride.stateVersion, paymentMethod: meta?.paymentMethod ?? null, pickup: q?.pickup ?? null, destination: q?.destination ?? null,
        estimatedFareMinor: q?.fare.totalMinor ?? null, finalFareMinor: meta?.finalFareMinor ?? null,
        rider: { phone: phone(rider?.phone) }, driver: driver ? { phone: phone(driver.phone), registration: prof?.registration ?? null, category: prof?.category ?? null } : null,
        timeline: (await r.rideEvents(ride.id)).map(e => ({ type: e.type, at: e.at, stateVersion: e.stateVersion })),
        payment: pay ? { status: pay.status, amountMinor: pay.amountMinor, attempt: pay.attempt, refundedMinor: pay.refundedMinor,
          refunds: refunds.map(f => ({ id: f.id, amountMinor: f.amountMinor, kind: f.kind, status: f.status, reason: f.reason, createdAt: f.createdAt })) } : null,
        ledger: await r.ledgerForTransactions(txIds),
      };
    });
  }

  /**
   * Completion, final-fare snapshot and money movement commit in ONE transaction. CASH posts the ledger split now;
   * UPI creates a PENDING payment (the ledger is only written when the provider confirms capture).
   */
  async complete(rideId: string, actor: Actor) {
    let finalFareMinor = 0; let method: string | null = null;
    const ride = await this.dispatch.command(rideId, 'COMPLETE', actor, async (r) => {
      const meta = (await r.getRideMeta(rideId))!; const q = (await r.getQuote(meta.fareQuoteId!))!; method = meta.paymentMethod;
      finalFareMinor = q.fare.totalMinor; await r.setFinalFare(rideId, finalFareMinor);
      if (meta.paymentMethod === 'CASH') await r.postLedger(`cash-ride:${rideId}`, cashRideLines(rideId, finalFareMinor, PILOT_RULE.commissionBps));
      else if (meta.paymentMethod === 'UPI') await this.payments.createForRide(r, rideId, finalFareMinor);
    });
    // Provider call happens AFTER the commit; if the gateway is down the payment stays PENDING and the worker retries.
    if (method === 'UPI') await this.payments.ensureForRide(rideId).catch(() => undefined);
    const payment = method === 'UPI' ? await this.db.tx(r => r.getPaymentByRide(rideId)) : undefined;
    return { ...ride, finalFareMinor, paymentStatus: payment?.status ?? (method === 'CASH' ? 'CASH_DUE' : null) };
  }

  /**
   * Cancellation with fee policy (PRD RDR-06):
   * - Rider cancels before driver assignment: no fee.
   * - Rider cancels after driver assignment: cancellation fee charged.
   * - Driver/system cancels: no fee to rider.
   */
  async cancel(rideId: string, actor: Actor) {
    let cancellationFeeMinor = 0;
    const ride = await this.dispatch.command(rideId, 'CANCEL', actor, async (r, next) => {
      // Fee only when RIDER cancels after a driver was assigned
      if (actor.kind === 'RIDER' && next.driverId) {
        cancellationFeeMinor = PILOT_RULE.cancellationFeeMinor;
        await r.postLedger(`cancel-fee:${rideId}`, cancellationFeeLines(rideId, cancellationFeeMinor, PILOT_RULE.commissionBps, true));
      }
    });
    return { ...ride, cancellationFeeMinor };
  }
}
