import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DispatchService } from '../src/domain/dispatch';
import { DriverState, Db } from '../src/domain/ports';
import { calculateFare, PricingRule } from '../src/domain/fare';
import { Ledger } from '../src/domain/ledger';
import { transition, Ride } from '../src/domain/rideStateMachine';
import { DomainError } from '../src/domain/errors';
import { closePool, makeDb, PG_URL } from './harness';

const PICKUP = { lat: 21.1458, lng: 79.0882 };
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: DomainError) => e.code ?? String(e));

describe('fares', () => {
  const rule: PricingRule = { version: 1, baseMinor: 3000, perKmMinor: 1200, perMinMinor: 150, minimumMinor: 5000, cancellationFeeMinor: 2000, commissionBps: 1500 };
  it('itemises in integer paise with half-up rounding', () => {
    const f = calculateFare(rule, 8_250, 1_230);
    expect(f.distanceMinor).toBe(9900); expect(f.timeMinor).toBe(3075); expect(f.totalMinor).toBe(3000 + 9900 + 3075);
  });
  it('applies minimum fare', () => expect(calculateFare(rule, 500, 60).totalMinor).toBe(5000));
  it('rejects non-integer input', () => expect(() => calculateFare(rule, 1.5, 60)).toThrow());
});

describe('state machine (AC-04)', () => {
  const base: Ride = { id: 'r', riderId: 'a', driverId: 'd1', status: 'DRIVER_ARRIVED', stateVersion: 5 };
  it('rejects invalid transition without mutating', () => {
    expect(() => transition(base, 'COMPLETE', { kind: 'DRIVER', id: 'd1' })).toThrow(/not allowed/); expect(base.status).toBe('DRIVER_ARRIVED');
  });
  it('only assigned driver may act', () => expect(() => transition(base, 'START_TRIP', { kind: 'DRIVER', id: 'other' })).toThrow(DomainError));
  it('another rider cannot cancel', () => expect(() => transition(base, 'CANCEL', { kind: 'RIDER', id: 'mallory' })).toThrow(/Not your ride/));
  it('terminal states are final', () => expect(() => transition({ ...base, status: 'COMPLETED' }, 'CANCEL', { kind: 'RIDER', id: 'a' })).toThrow());
});

describe('ledger unit (AC-07)', () => {
  it('records PRD ₹200 cash example: 200 DR = 170 + 30 CR', () => {
    const l = new Ledger(); expect(l.recordCashRide('r1', 20000, 1500)).toBe(true);
    expect(l.balance('platform_commission')).toBe(3000); expect(l.balance('driver_payable:r1')).toBe(17000); expect(l.totals().debit).toBe(l.totals().credit);
  });
  it('retry has no second financial effect', () => { const l = new Ledger(); l.recordCashRide('r1', 20000, 1500); expect(l.recordCashRide('r1', 20000, 1500)).toBe(false); expect(l.all()).toHaveLength(3); });
  it('rejects unbalanced transactions', () => {
    expect(() => new Ledger().post('x', [{ account: 'a', direction: 'DEBIT', amountMinor: 100 }, { account: 'b', direction: 'CREDIT', amountMinor: 90 }])).toThrow(/not balanced/);
  });
});

// The SAME dispatch suite runs against the in-memory and the Postgres implementation.
const impls: ('memory' | 'postgres')[] = PG_URL ? ['memory', 'postgres'] : ['memory'];
afterAll(closePool);

describe.each(impls)('dispatch [%s]', kind => {
  let db: Db, svc: DispatchService, t: number;
  const driver = (id: string, dLat = 0.01, over: Partial<DriverState> = {}): DriverState => ({
    id, approved: true, online: true, vehicleCategory: 'AUTO', zoneId: 'nagpur-pilot', lat: PICKUP.lat + dLat, lng: PICKUP.lng, lastLocationAt: t, activeRideId: null, ...over });
  const seed = (d: DriverState) => db.tx(r => r.saveDriver(d));
  const req = (key = 'k1', riderId = 'rider1') => ({ riderId, zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: key });
  const ride = (id: string) => db.tx(r => r.getRide(id));
  const drv = (id: string) => db.tx(r => r.getDriver(id));
  const offers = (rideId: string) => db.tx(r => r.offersForRide(rideId));
  const pending = async (rideId: string) => (await offers(rideId)).filter(o => o.status === 'PENDING');

  beforeEach(async () => {
    t = 1_000_000; db = await makeDb(kind);
    svc = new DispatchService(db, { offerTimeoutMs: 15_000, locationFreshnessMs: 30_000, maxOffers: 5 }, () => t);
  });

  it('AC-03: duplicate booking creates one ride', async () => {
    await seed(driver('d1'));
    const [a, b] = await Promise.all([svc.createRide(req()), svc.createRide(req())]);
    expect(a.id).toBe(b.id); expect(await offers(a.id)).toHaveLength(1);
  });
  it('offers nearest eligible driver first, deterministic', async () => {
    await seed(driver('far', 0.05)); await seed(driver('near', 0.005));
    const r = await svc.createRide(req()); expect((await pending(r.id))[0]!.driverId).toBe('near');
  });
  it('AC-09: stale GPS, offline, unapproved, busy and out-of-radius drivers are skipped', async () => {
    await seed(driver('stale', 0.001, { lastLocationAt: t - 60_000 })); await seed(driver('off', 0.001, { online: false }));
    await seed(driver('unapp', 0.001, { approved: false })); await seed(driver('wrongcat', 0.001, { vehicleCategory: 'CAR' }));
    await seed(driver('toofar', 0.5)); await seed(driver('ok', 0.02));
    const r = await svc.createRide(req()); expect((await pending(r.id)).map(o => o.driverId)).toEqual(['ok']);
  });
  it('AC-01: the same offer accepted concurrently -> exactly one assignment', async () => {
    await seed(driver('d1')); const r = await svc.createRide(req()); const o = (await pending(r.id))[0]!;
    const res = (await Promise.all([1, 2, 3, 4].map(() => code(svc.acceptOffer(o.id, 'd1'))))).sort();
    expect(res).toEqual(['OFFER_NOT_PENDING', 'OFFER_NOT_PENDING', 'OFFER_NOT_PENDING', 'OK']);
    expect((await ride(r.id))!.status).toBe('DRIVER_ASSIGNED');
  });
  it('AC-01: one driver offered two rides accepts both at once -> only one wins', async () => {
    await seed(driver('d1'));
    const r1 = await svc.createRide(req('k1', 'rider1')); const r2 = await svc.createRide(req('k2', 'rider2'));
    const o1 = (await pending(r1.id))[0]!, o2 = (await pending(r2.id))[0]!;
    const res = (await Promise.all([code(svc.acceptOffer(o1.id, 'd1')), code(svc.acceptOffer(o2.id, 'd1'))])).sort();
    expect(res).toEqual(['DRIVER_BUSY', 'OK']);
    const statuses = [(await ride(r1.id))!.status, (await ride(r2.id))!.status];
    expect(statuses.filter(s => s === 'DRIVER_ASSIGNED')).toHaveLength(1);
    const winner = (await ride(r1.id))!.status === 'DRIVER_ASSIGNED' ? r1.id : r2.id;
    expect((await drv('d1'))!.activeRideId).toBe(winner);
  });
  it('AC-02: expired offer cannot be accepted; the expiry commits and the next driver is offered', async () => {
    await seed(driver('d1')); await seed(driver('d2', 0.02));
    const r = await svc.createRide(req()); const o = (await pending(r.id))[0]!;
    t += 15_001; await seed(driver('d1')); await seed(driver('d2', 0.02));
    expect(await code(svc.acceptOffer(o.id, 'd1'))).toBe('OFFER_EXPIRED');
    expect((await ride(r.id))!.driverId).toBeNull();
    expect((await offers(r.id)).find(x => x.id === o.id)!.status).toBe('EXPIRED'); // expiry was committed, not rolled back
    expect((await pending(r.id))[0]!.driverId).toBe('d2');
  });
  it('rejection and timeout advance sequentially, then EXPIRED on exhaustion', async () => {
    await seed(driver('d1')); await seed(driver('d2', 0.02));
    const r = await svc.createRide(req()); await svc.rejectOffer((await pending(r.id))[0]!.id, 'd1');
    expect((await pending(r.id))[0]!.driverId).toBe('d2');
    t += 16_000; await svc.sweep();
    expect((await ride(r.id))!.status).toBe('EXPIRED'); expect(await pending(r.id)).toHaveLength(0);
  });
  it('AC-11: going offline invalidates the offer; driver never gets assigned', async () => {
    await seed(driver('d1')); const r = await svc.createRide(req()); const o = (await pending(r.id))[0]!;
    await svc.goOffline('d1');
    expect(await code(svc.acceptOffer(o.id, 'd1'))).toBe('OFFER_NOT_PENDING'); expect((await ride(r.id))!.status).toBe('EXPIRED');
  });
  it('full lifecycle; duplicate completion does not double-finalise; driver freed', async () => {
    await seed(driver('d1')); const r = await svc.createRide(req()); await svc.acceptOffer((await pending(r.id))[0]!.id, 'd1');
    const D = { kind: 'DRIVER', id: 'd1' } as const;
    for (const c of ['DRIVER_EN_ROUTE', 'ARRIVE', 'START_TRIP', 'COMPLETE'] as const) await svc.command(r.id, c, D);
    expect((await ride(r.id))!.status).toBe('COMPLETED');
    expect(await code(svc.command(r.id, 'COMPLETE', D))).toBe('INVALID_TRANSITION'); expect((await drv('d1'))!.activeRideId).toBeNull();
  });
  it('cancel invalidates the live offer and frees the driver', async () => {
    await seed(driver('d1')); const r = await svc.createRide(req());
    await svc.command(r.id, 'CANCEL', { kind: 'RIDER', id: 'rider1' });
    expect((await offers(r.id))[0]!.status).toBe('INVALIDATED');
    const ev = (await db.tx(x => x.listOutbox())).filter(e => e.type === 'ride.offer.invalidated');      // the offered driver is told
    expect(ev).toHaveLength(1); expect(ev[0]!.payload).toMatchObject({ driverId: 'd1', reason: 'RIDE_CANCELLED' });
  });
  it('outbox records each state change durably', async () => {
    await seed(driver('d1')); await svc.createRide(req());
    expect((await db.tx(r => r.listOutbox())).map(e => e.type)).toEqual(['ride.status.changed', 'ride.offer.created']);
  });
  it('ledger is idempotent and balanced through the repo', async () => {
    const lines = [{ account: 'a', direction: 'DEBIT' as const, amountMinor: 200 }, { account: 'b', direction: 'CREDIT' as const, amountMinor: 200 }];
    expect(await db.tx(r => r.postLedger('t1', lines))).toBe(true); expect(await db.tx(r => r.postLedger('t1', lines))).toBe(false);
    expect(await code(db.tx(r => r.postLedger('t2', [{ ...lines[0]! }, { ...lines[1]!, amountMinor: 150 }])))).toBe('LEDGER_UNBALANCED');
    expect(await db.tx(r => r.ledgerTotals())).toEqual({ debit: 200, credit: 200 });
  });
});
