import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DispatchService } from '../src/domain/dispatch';
import { cashRideLines } from '../src/domain/ledger';
import { DriverState } from '../src/domain/ports';
import { PgDb } from '../src/pg/PgDb';
import { migrate } from '../src/pg/migrate';
import { closePool, getPool, PG_URL, resetPg } from './harness';

const PICKUP = { lat: 21.1458, lng: 79.0882 };
const D = (id: string, t: number, over: Partial<DriverState> = {}): DriverState => ({ id, approved: true, online: true, vehicleCategory: 'AUTO', zoneId: 'nagpur-pilot', lat: PICKUP.lat + 0.01, lng: PICKUP.lng, lastLocationAt: t, activeRideId: null, ...over });
const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => e.code ?? e.constraint ?? String(e.message));
const sqlErr = async (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => `${e.code}:${e.constraint ?? ''}:${e.message}`);

describe.skipIf(!PG_URL)('postgres invariants and concurrency', () => {
  let pool: Pool, db: PgDb, svc: DispatchService; const t = 1_000_000;
  const q = (sql: string, p: unknown[] = []) => pool.query(sql, p);
  const mkRide = async (status = 'SEARCHING', driverId: string | null = null, version = 2) => {
    const id = randomUUID();
    await q(`INSERT INTO "Ride"(id,"riderId","driverId",status,"stateVersion","zoneId",category,"pickupLat","pickupLng") VALUES($1,'r',$2,$3,$4,'z','AUTO',21.1,79.0)`, [id, driverId, status, version]);
    return id;
  };
  beforeEach(async () => { await resetPg(); pool = getPool(); db = new PgDb(pool);
    svc = new DispatchService(db, { offerTimeoutMs: 15_000, locationFreshnessMs: 30_000, maxOffers: 5 }, () => t); });
  afterAll(closePool);

  it('migrations are idempotent', async () => { expect(await migrate(pool)).toEqual([]); });

  describe('the database rejects violations even when application code is bypassed', () => {
    it('two ACTIVE assignments for one ride (AC-01)', async () => {
      const r = await mkRide('DRIVER_ASSIGNED', 'd1');
      await q(`INSERT INTO "RideAssignment"("rideId","driverId") VALUES($1,'d1')`, [r]);
      expect(await sqlErr(q(`INSERT INTO "RideAssignment"("rideId","driverId") VALUES($1,'d2')`, [r]))).toMatch(/23505:ride_assignment_one_active_per_ride/);
    });
    it('one driver on two active rides', async () => {
      const a = await mkRide('DRIVER_ASSIGNED', 'd1'), b = await mkRide('DRIVER_ASSIGNED', 'd1');
      await q(`INSERT INTO "RideAssignment"("rideId","driverId") VALUES($1,'d1')`, [a]);
      expect(await sqlErr(q(`INSERT INTO "RideAssignment"("rideId","driverId") VALUES($1,'d1')`, [b]))).toMatch(/one_active_per_driver/);
    });
    it('two PENDING offers for one ride; same driver re-offered', async () => {
      const r = await mkRide(); const ins = (seq: number, d: string, st = 'PENDING') => q(`INSERT INTO "RideOffer"(id,"rideId","driverId","sequenceNumber","dispatchAttemptId",status,"createdAt","expiresAt") VALUES($1,$2,$3,$4,$6,$5,now(),now()+interval '15s')`, [randomUUID(), r, d, seq, st, r]);
      await ins(1, 'd1'); expect(await sqlErr(ins(2, 'd2'))).toMatch(/ride_offer_one_pending_per_ride/);
      expect(await sqlErr(ins(3, 'd1', 'EXPIRED'))).toMatch(/ride_offer_driver_once/);
    });
    it('illegal transition SEARCHING -> COMPLETED; skipped version; terminal state is final', async () => {
      const r = await mkRide('SEARCHING', null, 2);
      expect(await sqlErr(q(`UPDATE "Ride" SET status='COMPLETED',"stateVersion"=3 WHERE id=$1`, [r]))).toMatch(/illegal ride transition/);
      expect(await sqlErr(q(`UPDATE "Ride" SET status='EXPIRED',"stateVersion"=9 WHERE id=$1`, [r]))).toMatch(/advance by exactly 1/);
      await q(`UPDATE "Ride" SET status='EXPIRED',"stateVersion"=3 WHERE id=$1`, [r]);
      expect(await sqlErr(q(`UPDATE "Ride" SET status='SEARCHING',"stateVersion"=4 WHERE id=$1`, [r]))).toMatch(/illegal ride transition/);
    });
    it('assigned ride must have a driver; final fare is immutable', async () => {
      expect(await sqlErr(mkRide('DRIVER_ASSIGNED', null))).toMatch(/23514/);
      const r = await mkRide('IN_PROGRESS', 'd1'); await q(`UPDATE "Ride" SET "finalFareMinor"=5000 WHERE id=$1`, [r]);
      expect(await sqlErr(q(`UPDATE "Ride" SET "finalFareMinor"=1 WHERE id=$1`, [r]))).toMatch(/final fare is immutable/);
    });
    it('ledger: unbalanced commit fails; entries cannot be edited or deleted; audit is append-only', async () => {
      const c = await pool.connect();
      await c.query('BEGIN'); await c.query(`INSERT INTO "LedgerTransaction"(id) VALUES('bad')`);
      await c.query(`INSERT INTO "LedgerEntry"("transactionId",account,direction,"amountMinor") VALUES('bad','a','DEBIT',100),('bad','b','CREDIT',99)`);
      expect(await sqlErr(c.query('COMMIT'))).toMatch(/unbalanced ledger transaction/); await c.query('ROLLBACK').catch(() => {}); c.release();
      await db.tx(r => r.postLedger('ok', [{ account: 'a', direction: 'DEBIT', amountMinor: 100 }, { account: 'b', direction: 'CREDIT', amountMinor: 100 }]));
      expect(await sqlErr(q(`UPDATE "LedgerEntry" SET "amountMinor"=1`))).toMatch(/append-only/);
      expect(await sqlErr(q(`DELETE FROM "LedgerEntry"`))).toMatch(/append-only/);
      await db.tx(r => r.addAudit({ actorId: 'a', action: 'X', targetId: 't', reason: 'why', before: null, after: 1, at: t }));
      expect(await sqlErr(q(`DELETE FROM "AuditLog"`))).toMatch(/append-only/);
    });
    it('duplicate vehicle registration maps to a domain error', async () => {
      const p = { verification: 'PENDING' as const, category: 'AUTO', registration: 'MH31AB1234', lastSeq: -1 };
      await db.tx(r => r.saveProfile({ ...p, userId: 'u1' }));
      expect(await code(db.tx(r => r.saveProfile({ ...p, userId: 'u2' })))).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('real concurrency across pooled connections', () => {
    it('AC-01: 12 rides race for ONE driver -> exactly one assignment, database agrees', async () => {
      await db.tx(r => r.saveDriver(D('d1', t)));
      const rides = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.createRide({ riderId: `rider${i}`, zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: `key-${i}-abcdefgh` })));
      const offers = (await Promise.all(rides.map(r => db.tx(x => x.offersForRide(r.id))))).flat().filter(o => o.status === 'PENDING');
      expect(offers.length).toBe(12);
      const res = await Promise.all(offers.map(o => code(svc.acceptOffer(o.id, 'd1'))));
      expect(res.filter(x => x === 'OK')).toHaveLength(1); expect(res.filter(x => x === 'DRIVER_BUSY')).toHaveLength(11);
      expect((await q(`SELECT count(*)::int c FROM "RideAssignment" WHERE status='ACTIVE'`)).rows[0].c).toBe(1);
      expect((await q(`SELECT count(*)::int c FROM "Ride" WHERE status='DRIVER_ASSIGNED'`)).rows[0].c).toBe(1);
    });
    it('AC-03: 15 concurrent identical bookings -> one ride, one offer', async () => {
      await db.tx(r => r.saveDriver(D('d1', t)));
      const out = await Promise.all(Array.from({ length: 15 }, () => svc.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'same-key-12345' })));
      expect(new Set(out.map(r => r.id)).size).toBe(1);
      expect((await q(`SELECT count(*)::int c FROM "Ride"`)).rows[0].c).toBe(1); expect((await q(`SELECT count(*)::int c FROM "RideOffer"`)).rows[0].c).toBe(1);
    });
    it('concurrent COMPLETE: one wins; fare snapshot and ledger post exactly once', async () => {
      await db.tx(r => r.saveDriver(D('d1', t)));
      const ride = await svc.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'complete-race-1' });
      await svc.acceptOffer((await db.tx(r => r.offersForRide(ride.id)))[0]!.id, 'd1');
      const drv = { kind: 'DRIVER', id: 'd1' } as const;
      for (const c of ['DRIVER_EN_ROUTE', 'ARRIVE', 'START_TRIP'] as const) await svc.command(ride.id, c, drv);
      const fin = async (r: any) => { await r.setFinalFare(ride.id, 20000); await r.postLedger(`cash-ride:${ride.id}`, cashRideLines(ride.id, 20000, 1500)); };
      const res = await Promise.all(Array.from({ length: 6 }, () => code(svc.command(ride.id, 'COMPLETE', drv, fin))));
      expect(res.filter(x => x === 'OK')).toHaveLength(1); expect(res.filter(x => x === 'INVALID_TRANSITION')).toHaveLength(5);
      expect((await q(`SELECT count(*)::int c FROM "LedgerEntry"`)).rows[0].c).toBe(3);
      expect(await db.tx(r => r.ledgerTotals())).toEqual({ debit: 20000, credit: 20000 });
      expect(await db.tx(r => r.ledgerBalance('platform_commission'))).toBe(3000);
    });
    it('AC-07: concurrent identical ledger posts have one financial effect', async () => {
      const lines = cashRideLines('rX', 20000, 1500);
      const res = await Promise.all(Array.from({ length: 8 }, () => db.tx(r => r.postLedger('cash-ride:rX', lines))));
      expect(res.filter(Boolean)).toHaveLength(1); expect((await q(`SELECT count(*)::int c FROM "LedgerEntry"`)).rows[0].c).toBe(3);
    });
    it('worker sweeps running concurrently do not double-advance the offer sequence', async () => {
      await db.tx(r => r.saveDriver(D('d1', t))); await db.tx(r => r.saveDriver(D('d2', t, { lat: PICKUP.lat + 0.02 })));
      const ride = await svc.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'sweep-race-123' });
      let later = t + 16_000; const s2 = new DispatchService(db, { offerTimeoutMs: 15_000, locationFreshnessMs: 60_000, maxOffers: 5 }, () => later);
      await Promise.all([s2.sweep(), s2.sweep(), s2.sweep(), s2.sweep()]);
      const offers = await db.tx(r => r.offersForRide(ride.id));
      expect(offers.filter(o => o.status === 'PENDING')).toHaveLength(1); expect(offers.map(o => o.sequenceNumber)).toEqual([1, 2]);
    });
  });

  describe('durability and atomicity', () => {
    it('AC-12: committed bookings, offers and outbox survive a full connection restart; dispatch resumes', async () => {
      await db.tx(r => r.saveDriver(D('d1', t)));
      const ride = await svc.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'survive-restart-1' });
      const pool2 = new Pool({ connectionString: PG_URL }); const db2 = new PgDb(pool2);   // "new process"
      const svc2 = new DispatchService(db2, { offerTimeoutMs: 15_000, locationFreshnessMs: 30_000, maxOffers: 5 }, () => t);
      expect((await db2.tx(r => r.getRide(ride.id)))!.status).toBe('SEARCHING');
      expect((await db2.tx(r => r.listOutbox())).map(e => e.type)).toEqual(['ride.status.changed', 'ride.offer.created']);
      expect((await svc2.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'survive-restart-1' })).id).toBe(ride.id);
      expect((await svc2.acceptOffer((await db2.tx(r => r.offersForRide(ride.id)))[0]!.id, 'd1')).status).toBe('DRIVER_ASSIGNED');
      await pool2.end();
    });
    it('a failure inside completion rolls EVERYTHING back (state, fare, ledger, outbox)', async () => {
      await db.tx(r => r.saveDriver(D('d1', t)));
      const ride = await svc.createRide({ riderId: 'rider1', zoneId: 'nagpur-pilot', category: 'AUTO', pickup: PICKUP, idempotencyKey: 'rollback-test-1' });
      await svc.acceptOffer((await db.tx(r => r.offersForRide(ride.id)))[0]!.id, 'd1');
      const drv = { kind: 'DRIVER', id: 'd1' } as const;
      for (const c of ['DRIVER_EN_ROUTE', 'ARRIVE', 'START_TRIP'] as const) await svc.command(ride.id, c, drv);
      const before = (await db.tx(r => r.listOutbox())).length;
      await expect(svc.command(ride.id, 'COMPLETE', drv, async r => { await r.postLedger('boom', cashRideLines(ride.id, 20000, 1500)); throw new Error('provider exploded'); })).rejects.toThrow('provider exploded');
      expect((await db.tx(r => r.getRide(ride.id)))!.status).toBe('IN_PROGRESS');
      expect((await q(`SELECT count(*)::int c FROM "LedgerEntry"`)).rows[0].c).toBe(0);
      expect((await db.tx(r => r.listOutbox())).length).toBe(before);
      expect((await db.tx(r => r.getDriver('d1')))!.activeRideId).toBe(ride.id);
    });
    it('malformed ids are a clean not-found, never a 500', async () => {
      expect(await db.tx(r => r.getRide('not-a-uuid'))).toBeUndefined(); expect(await db.tx(r => r.getOffer('x'))).toBeUndefined();
    });
  });
});
