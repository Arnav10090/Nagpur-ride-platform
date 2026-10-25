import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FakeProvider } from '../src/domain/payments/fakeProvider';
import { ProviderUnavailable, SignatureError } from '../src/domain/payments/provider';
import { PaymentService } from '../src/domain/payments/service';
import { Db } from '../src/domain/ports';
import { closePool, getPool, makeDb, PG_URL } from './harness';

const impls: ('memory' | 'postgres')[] = PG_URL ? ['memory', 'postgres'] : ['memory'];
afterAll(closePool);
const err = async (p: Promise<unknown>) => p.then(() => 'OK', (e: any) => e.code ?? e.name ?? String(e.message));
const FARE = 20000; // 200.00 INR; 15% commission = 3000, driver 17000

describe.each(impls)('UPI payments [%s]', kind => {
  let db: Db, t: number, prov: FakeProvider, svc: PaymentService;
  const bal = (a: string) => db.tx(r => r.ledgerBalance(a));
  const events = () => db.tx(r => r.listPaymentEvents());
  const pay = (id: string) => db.tx(r => r.getPayment(id));
  const hook = (e: { rawBody: string; signature: string }) => svc.handleWebhook(e.rawBody, e.signature);
  const balanced = async () => { const x = await db.tx(r => r.ledgerTotals()); expect(x.debit).toBe(x.credit); };

  /** A completed UPI ride whose payment is awaiting the rider. */
  async function newPayment(fare = FARE) {
    const rideId = randomUUID();
    await db.tx(async r => { await r.insertRide({ id: rideId, riderId: 'rider1', driverId: 'd1', status: 'COMPLETED', stateVersion: 6 }, { riderId: 'rider1', zoneId: 'z', category: 'AUTO', pickup: { lat: 21.1, lng: 79.0 }, idempotencyKey: 'k', paymentMethod: 'UPI' }); await svc.createForRide(r, rideId, fare); });
    const p = (await svc.ensureForRide(rideId))!; return { rideId, p };
  }
  beforeEach(async () => { t = 5_000_000; db = await makeDb(kind); prov = new FakeProvider({ secret: 'whsec_test', now: () => t }); svc = new PaymentService(db, prov, { commissionBps: 1500, now: () => t, staleMs: 120_000 }); });

  describe('creation', () => {
    it('creates a provider payment with a UPI intent; concurrent calls create exactly one', async () => {
      const rideId = randomUUID();
      await db.tx(async r => { await r.insertRide({ id: rideId, riderId: 'rider1', driverId: 'd1', status: 'COMPLETED', stateVersion: 6 }, { riderId: 'rider1', zoneId: 'z', category: 'AUTO', pickup: { lat: 21.1, lng: 79 }, idempotencyKey: 'k' }); await svc.createForRide(r, rideId, FARE); });
      const res = await Promise.all(Array.from({ length: 5 }, () => svc.ensureForRide(rideId)));
      expect(new Set(res.map(x => x!.providerRef)).size).toBe(1); expect(prov.payments.size).toBe(1);
      expect(res[0]!.status).toBe('REQUIRES_ACTION'); expect(res[0]!.intent!.upiUri).toMatch(/^upi:\/\/pay\?.*am=200\.00.*cu=INR/);
    });
    it('provider outage leaves the payment PENDING and the worker completes it later', async () => {
      const rideId = randomUUID();
      await db.tx(async r => { await r.insertRide({ id: rideId, riderId: 'rider1', driverId: 'd1', status: 'COMPLETED', stateVersion: 6 }, { riderId: 'rider1', zoneId: 'z', category: 'AUTO', pickup: { lat: 21.1, lng: 79 }, idempotencyKey: 'k' }); await svc.createForRide(r, rideId, FARE); });
      prov.failCreate = 1; expect(await err(svc.ensureForRide(rideId))).toBe('ProviderUnavailable');
      expect((await db.tx(r => r.getPaymentByRide(rideId)))!.status).toBe('PENDING');
      await svc.processOutbound(); expect((await db.tx(r => r.getPaymentByRide(rideId)))!.status).toBe('REQUIRES_ACTION');
    });
  });

  describe('AC-05: forged or tampered webhooks change nothing', () => {
    it('rejects wrong secret, tampered body, replayed-old timestamp, missing/garbled header and malformed payloads', async () => {
      const { p } = await newPayment(); const good = prov.settle(p.providerRef!, 'SUCCEEDED');
      const attacker = new FakeProvider({ secret: 'guessed', now: () => t }); attacker.payments = prov.payments;
      const bad: [string, () => Promise<unknown>][] = [
        ['wrong secret', () => hook(attacker.settle(p.providerRef!, 'SUCCEEDED'))],
        ['tampered body', () => svc.handleWebhook(good.rawBody.replace('20000', '1'), good.signature)],
        ['stale timestamp (replay)', () => svc.handleWebhook(good.rawBody, prov.signature(good.rawBody, Math.floor(t / 1000) - 3600))],
        ['future timestamp', () => svc.handleWebhook(good.rawBody, prov.signature(good.rawBody, Math.floor(t / 1000) + 3600))],
        ['missing header', () => svc.handleWebhook(good.rawBody, undefined)],
        ['garbled header', () => svc.handleWebhook(good.rawBody, 't=abc,v1=zz')],
        ['signed garbage', () => svc.handleWebhook('not json', prov.signature('not json'))],
        ['signed unknown type', () => { const b = JSON.stringify({ id: 'x', type: 'payment.refunded_all', data: { providerRef: 'a', amountMinor: 1 } }); return svc.handleWebhook(b, prov.signature(b)); }],
      ];
      for (const [name, f] of bad) expect(await err(f()), name).toBe('SignatureError');
      expect((await pay(p.id))!.status).toBe('REQUIRES_ACTION'); expect(await events()).toHaveLength(0); expect(await db.tx(r => r.ledgerTotals())).toEqual({ debit: 0, credit: 0 });
      expect(await hook(good)).toBe('CAPTURED'); // and the genuine one still works
    });
  });

  describe('capture', () => {
    it('a verified success marks the payment SUCCEEDED and books a balanced ledger split', async () => {
      const { p } = await newPayment(); expect(await hook(prov.settle(p.providerRef!, 'SUCCEEDED'))).toBe('CAPTURED');
      expect((await pay(p.id))!.status).toBe('SUCCEEDED'); expect((await pay(p.id))!.intent).toBeNull();
      expect(await bal('provider_receivable')).toBe(-FARE); expect(await bal(`driver_payable:${p.rideId}`)).toBe(17000); expect(await bal('platform_commission')).toBe(3000);
      await balanced(); expect((await db.tx(r => r.listOutbox())).some(e => e.type === 'payment.status.changed' && e.payload.status === 'SUCCEEDED' && e.payload.riderId === 'rider1')).toBe(true);
    });
    it('AC-06: the same event delivered 8 times at once has ONE effect', async () => {
      const { p } = await newPayment(); const e = prov.settle(p.providerRef!, 'SUCCEEDED');
      const out = await Promise.all(Array.from({ length: 8 }, () => hook(e)));
      expect(out.filter(x => x === 'CAPTURED')).toHaveLength(1); expect(out.filter(x => x === 'DUPLICATE')).toHaveLength(7);
      expect((await db.tx(r => r.ledgerTotals())).debit).toBe(FARE); expect(await events()).toHaveLength(1);
    });
    it('a re-sent success under a DIFFERENT event id is ignored (no second ledger entry, no refund)', async () => {
      const { p } = await newPayment(); await hook(prov.settle(p.providerRef!, 'SUCCEEDED'));
      expect(await hook(prov.signedEvent({ type: 'payment.succeeded', providerRef: p.providerRef!, amountMinor: FARE }))).toBe('IGNORED');
      expect((await db.tx(r => r.ledgerTotals())).debit).toBe(FARE); expect(await db.tx(r => r.listRefunds(p.id))).toHaveLength(0);
    });
    it('an amount that differs from what we asked for is NOT accepted; it is held as a finding', async () => {
      const { p } = await newPayment();
      expect(await hook(prov.settle(p.providerRef!, 'SUCCEEDED', { amountMinor: 100 }))).toBe('AMOUNT_MISMATCH');
      expect((await pay(p.id))!.status).toBe('REQUIRES_ACTION'); expect((await db.tx(r => r.listFindings())).map(f => f.kind)).toEqual(['AMOUNT_MISMATCH']);
      expect(await db.tx(r => r.ledgerTotals())).toEqual({ debit: 0, credit: 0 });
    });
    it('an event for a reference we cannot place yet is NOT consumed, so the provider retry succeeds once it is known', async () => {
      const rideId = randomUUID();
      await db.tx(async r => { await r.insertRide({ id: rideId, riderId: 'rider1', driverId: 'd1', status: 'COMPLETED', stateVersion: 6 }, { riderId: 'rider1', zoneId: 'z', category: 'AUTO', pickup: { lat: 21.1, lng: 79 }, idempotencyKey: 'k' }); await svc.createForRide(r, rideId, FARE); });
      const pending = (await db.tx(r => r.getPaymentByRide(rideId)))!;
      const early = await prov.createPayment({ idempotencyKey: `${pending.id}:1`, rideId, amountMinor: FARE }); // gateway fast-paths the customer before we saved the ref
      const e = prov.settle(early.providerRef, 'SUCCEEDED');
      expect(await hook(e)).toBe('UNKNOWN_REFERENCE'); expect(await events()).toHaveLength(0);
      await svc.ensureProviderPayment(pending.id); expect(await hook(e)).toBe('CAPTURED'); // same event id, now accepted
    });
  });

  describe('failure, retry and double payment', () => {
    it('failure then retry creates a NEW attempt; late payment on the old attempt is refunded, not kept', async () => {
      const { rideId, p } = await newPayment(); const ref1 = p.providerRef!;
      expect(await hook(prov.settle(ref1, 'FAILED'))).toBe('FAILED'); expect((await pay(p.id))!.status).toBe('FAILED');
      const p2 = (await svc.retry(rideId, 'rider1'))!; expect(p2.attempt).toBe(2); expect(p2.providerRef).not.toBe(ref1);
      expect(await hook(prov.settle(p2.providerRef!, 'SUCCEEDED'))).toBe('CAPTURED');
      expect(await hook(prov.settle(ref1, 'SUCCEEDED'))).toBe('DUPLICATE_CAPTURE');                      // the rider also paid the old QR
      expect((await pay(p.id))!.providerRef).toBe(p2.providerRef); expect(await bal(`unapplied_receipts:${rideId}`)).toBe(FARE); // owed back to the rider
      await svc.processOutbound();
      expect(await bal(`unapplied_receipts:${rideId}`)).toBe(0); expect(await bal('provider_receivable')).toBe(-FARE); // exactly one fare is ours
      expect((await db.tx(r => r.listRefunds(p.id)))[0]).toMatchObject({ kind: 'DUPLICATE_CAPTURE', status: 'SUCCEEDED' }); await balanced();
    });
    it('first capture wins when an older expired attempt is paid after a new one started', async () => {
      const { rideId, p } = await newPayment(); t += 11 * 60_000;                          // intent expired
      const p2 = (await svc.retry(rideId, 'rider1'))!; expect(p2.attempt).toBe(2);
      expect(await hook(prov.settle(p.providerRef!, 'SUCCEEDED'))).toBe('CAPTURED');       // rider paid the OLD intent: that money is real
      expect((await pay(p.id))!.providerRef).toBe(p.providerRef);
      expect(await hook(prov.settle(p2.providerRef!, 'SUCCEEDED'))).toBe('DUPLICATE_CAPTURE'); await balanced();
    });
    it('retry is refused while a live intent exists, and for someone else\'s ride', async () => {
      const { rideId } = await newPayment();
      expect(await err(svc.retry(rideId, 'rider1'))).toBe('PAYMENT_NOT_RETRYABLE'); expect(await err(svc.retry(rideId, 'mallory'))).toBe('NOT_FOUND');
    });
    it('a stale failure for an old attempt never un-pays a captured payment', async () => {
      const { p } = await newPayment(); await hook(prov.settle(p.providerRef!, 'SUCCEEDED'));
      expect(await hook(prov.signedEvent({ type: 'payment.failed', providerRef: p.providerRef!, amountMinor: FARE }))).toBe('IGNORED'); expect((await pay(p.id))!.status).toBe('SUCCEEDED');
    });
  });

  describe('reconciliation', () => {
    it('repairs a LOST success webhook, idempotently, and a late real webhook is then ignored', async () => {
      const { p } = await newPayment(); const lost = prov.settle(p.providerRef!, 'SUCCEEDED'); void lost;
      expect(await svc.reconcile()).toMatchObject({ checked: 0 }); // not stale yet
      t += 3 * 60_000; expect(await svc.reconcile()).toMatchObject({ checked: 1, repaired: 1 });
      expect((await pay(p.id))!.status).toBe('SUCCEEDED'); expect(await bal('platform_commission')).toBe(3000);
      expect(await svc.reconcile()).toMatchObject({ checked: 0, repaired: 0 }); expect(await hook(lost)).toBe('IGNORED'); await balanced();
    });
    it('repairs a lost failure webhook', async () => {
      const { p } = await newPayment(); prov.settle(p.providerRef!, 'FAILED'); t += 3 * 60_000; await svc.reconcile(); expect((await pay(p.id))!.status).toBe('FAILED');
    });
    it('reports payments the provider has but we never recorded, and ones we hold that the provider lacks; re-runs add nothing', async () => {
      const { p } = await newPayment(); const orphan = prov.injectOrphan(5000); prov.payments.delete(p.providerRef!); t += 3 * 60_000;
      expect(await svc.reconcile()).toMatchObject({ findings: 2 }); expect(await svc.reconcile()).toMatchObject({ findings: 0 });
      expect((await db.tx(r => r.listFindings())).map(f => `${f.kind}:${f.providerRef}`).sort()).toEqual([`MISSING_AT_PROVIDER:${p.providerRef}`, `ORPHAN_AT_PROVIDER:${orphan}`].sort());
    });
  });

  describe('refunds', () => {
    const paid = async () => { const x = await newPayment(); await hook(prov.settle(x.p.providerRef!, 'SUCCEEDED')); return x; };
    it('partial then final refund: statuses advance, ledger fully reverses, nothing left over', async () => {
      const { rideId, p } = await paid();
      await svc.requestRefund('fin1', rideId, 5000, 'goodwill'); expect((await pay(p.id))!.status).toBe('PARTIALLY_REFUNDED');
      await svc.requestRefund('fin1', rideId, 15000, 'remaining'); expect((await pay(p.id))!.status).toBe('REFUNDED');
      expect(await bal('provider_receivable')).toBe(0); expect(await bal(`driver_payable:${rideId}`)).toBe(0); expect(await bal('platform_commission')).toBe(0); await balanced();
      expect((await db.tx(r => r.listAudit())).filter(a => a.action === 'REFUND_REQUESTED')).toHaveLength(2);
    });
    it('cannot refund more than was paid, an uncaptured payment, or a non-positive amount', async () => {
      const { rideId } = await paid(); expect(await err(svc.requestRefund('f', rideId, FARE + 1, 'too much'))).toBe('REFUND_EXCEEDS_PAYMENT');
      expect(await err(svc.requestRefund('f', rideId, 0, 'zero'))).toBe('REFUND_EXCEEDS_PAYMENT');
      const u = await newPayment(); expect(await err(svc.requestRefund('f', u.rideId, 100, 'unpaid'))).toBe('INVALID_TRANSITION');
    });
    it('concurrent refund requests can never exceed the payment', async () => {
      const { rideId, p } = await paid();
      const res = await Promise.all(Array.from({ length: 6 }, () => err(svc.requestRefund('f', rideId, 12000, 'race'))));
      expect(res.filter(x => x === 'OK')).toHaveLength(1); expect(res.filter(x => x === 'REFUND_EXCEEDS_PAYMENT')).toHaveLength(5);
      expect((await pay(p.id))!.refundedMinor).toBe(12000); await balanced();
    });
    it('asynchronous provider: refund completes on its webhook, duplicates ignored', async () => {
      const { rideId, p } = await paid(); prov.refundMode = 'ASYNC';
      const x = await svc.requestRefund('f', rideId, FARE, 'full'); expect((await pay(p.id))!.status).toBe('SUCCEEDED'); expect(await bal('provider_receivable')).toBe(-FARE);
      const e = prov.settleRefund(x.id, 'SUCCEEDED'); expect(await hook(e)).toBe('REFUNDED'); expect(await hook(e)).toBe('DUPLICATE');
      expect((await pay(p.id))!.status).toBe('REFUNDED'); expect(await bal('provider_receivable')).toBe(0); await balanced();
    });
    it('a failed refund releases the reserved amount so it can be requested again', async () => {
      const { rideId, p } = await paid(); prov.refundMode = 'FAIL';
      await svc.requestRefund('f', rideId, 8000, 'try'); expect((await pay(p.id))!.refundedMinor).toBe(0); expect(await bal('provider_receivable')).toBe(-FARE);
      prov.refundMode = 'SYNC_SUCCESS'; await svc.requestRefund('f', rideId, 8000, 'again'); expect((await pay(p.id))!.refundedMinor).toBe(8000);
    });
    it('provider outage on refund: it stays REQUESTED and the worker sends it later, exactly once', async () => {
      const { rideId, p } = await paid(); const real = prov.refund.bind(prov); let calls = 0;
      prov.refund = async () => { calls++; throw new ProviderUnavailable(); };
      const x = await svc.requestRefund('f', rideId, FARE, 'outage'); expect(x.status).toBe('REQUESTED'); expect(calls).toBe(1);
      prov.refund = real; await svc.processOutbound(); await svc.processOutbound();
      expect((await pay(p.id))!.status).toBe('REFUNDED'); expect(prov.refunds.size).toBe(1); expect(await bal('provider_receivable')).toBe(0);
    });
  });
});

describe.skipIf(!PG_URL)('payment database guards', () => {
  it('refuses, even from raw SQL: over-refund, amount edits, final-state edits, duplicate events, duplicate payments per ride, unreferenced live payments', async () => {
    const db = await makeDb('postgres'); const q = (s: string, p: unknown[] = []) => getPool().query(s, p);
    const e = async (p: Promise<unknown>) => p.then(() => 'OK', (x: any) => `${x.code}:${x.constraint ?? ''}:${x.message}`);
    const rideId = randomUUID(); const payId = randomUUID();
    await db.tx(r => r.insertRide({ id: rideId, riderId: 'r', driverId: 'd', status: 'COMPLETED', stateVersion: 6 }, { riderId: 'r', zoneId: 'z', category: 'AUTO', pickup: { lat: 21.1, lng: 79 }, idempotencyKey: 'k' }));
    const ins = (id: string, ride: string, status = 'SUCCEEDED', ref: string | null = 'ref1') => q(`INSERT INTO "Payment"(id,"rideId","amountMinor",status,attempt,"providerRef","refundedMinor","createdAt","updatedAt") VALUES($1,$2,1000,$3,1,$4,0,now(),now())`, [id, ride, status, ref]);
    expect(await e(ins(payId, rideId, 'SUCCEEDED', null))).toMatch(/23514/);                     // captured payment must name its provider ref
    expect(await e(ins(payId, rideId))).toBe('OK');
    expect(await e(ins(randomUUID(), rideId))).toMatch(/Payment_rideId_key/);                      // one payment per ride
    expect(await e(q(`UPDATE "Payment" SET "refundedMinor"=1001 WHERE id=$1`, [payId]))).toMatch(/23514/); // cannot refund more than paid
    expect(await e(q(`UPDATE "Payment" SET "amountMinor"=5 WHERE id=$1`, [payId]))).toMatch(/amount is immutable/);
    await q(`UPDATE "Payment" SET status='REFUNDED',"refundedMinor"=1000 WHERE id=$1`, [payId]);
    expect(await e(q(`UPDATE "Payment" SET status='SUCCEEDED' WHERE id=$1`, [payId]))).toMatch(/refunded payment is final/);
    await q(`INSERT INTO "PaymentEvent"(provider,"providerEventId",type,"providerRef",payload) VALUES('fake','e1','payment.succeeded','ref1','{}')`);
    expect(await e(q(`INSERT INTO "PaymentEvent"(provider,"providerEventId",type,"providerRef",payload) VALUES('fake','e1','payment.succeeded','ref1','{}')`))).toMatch(/payment_event_provider_unique/);
    expect(await e(q(`DELETE FROM "PaymentEvent"`))).toMatch(/append-only/);
    const rf = (id: string) => q(`INSERT INTO "Refund"(id,"paymentId","providerRef","amountMinor",reason,kind,status,"requestedBy","createdAt") VALUES($1,$2,'refDUP',10,'dup capture','DUPLICATE_CAPTURE','REQUESTED','system',now())`, [id, payId]);
    await rf(randomUUID()); expect(await e(rf(randomUUID()))).toMatch(/refund_one_dup_per_capture/);   // at most one automatic refund per duplicate capture
  });
});
