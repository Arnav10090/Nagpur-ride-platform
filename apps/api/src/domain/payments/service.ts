import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors';
import { duplicateCaptureLines, duplicateRefundLines, refundLines, upiCaptureLines } from '../ledger';
import { Db, PaymentRec, RefundRec, Repo } from '../ports';
import { PaymentProvider, ProviderEvent } from './provider';

export interface PaymentConfig { commissionBps: number; now: () => number; staleMs?: number }
const CAPTURED = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/**
 * UPI payments. Rules enforced here AND by database constraints:
 *  - provider events are de-duplicated by (provider, eventId) in the same transaction as their effect (AC-06)
 *  - nothing is trusted from a webhook unless the HMAC verifies (AC-05); amounts must match what we asked for
 *  - money is confirmed only by provider events / reconciliation, never by the client
 *  - ledger entries are written in the SAME transaction as the status change, each idempotent on its own key
 *  - a second capture for one ride is never silently kept: it is booked as a liability and refunded
 */
export class PaymentService {
  constructor(private db: Db, private provider: PaymentProvider, private cfg: PaymentConfig) {}
  private get now() { return this.cfg.now(); }

  private async emitStatus(r: Repo, p: PaymentRec) {
    const ride = await r.getRide(p.rideId);
    await r.emit('payment.status.changed', p.rideId, { paymentId: p.id, status: p.status, amountMinor: p.amountMinor, attempt: p.attempt, riderId: ride?.riderId, driverId: ride?.driverId });
  }

  /** Called inside the ride-completion transaction so a completed UPI ride always has a payment record. */
  async createForRide(r: Repo, rideId: string, amountMinor: number) {
    const p: PaymentRec = { id: randomUUID(), rideId, amountMinor, status: 'PENDING', attempt: 1, providerRef: null, intent: null, refundedMinor: 0, createdAt: this.now, updatedAt: this.now };
    await r.insertPayment(p); await this.emitStatus(r, p); return p;
  }

  /** Creates the provider-side payment OUTSIDE any DB transaction. Safe to call repeatedly or concurrently (idempotency key). */
  async ensureProviderPayment(paymentId: string): Promise<PaymentRec | undefined> {
    const p = await this.db.tx(r => r.getPayment(paymentId));
    if (!p || p.status !== 'PENDING' || p.providerRef) return p;
    const created = await this.provider.createPayment({ idempotencyKey: `${p.id}:${p.attempt}`, rideId: p.rideId, amountMinor: p.amountMinor });
    return this.db.tx(async r => {
      const cur = (await r.getPayment(paymentId, true))!;
      if (cur.status !== 'PENDING' || cur.providerRef || cur.attempt !== p.attempt) return cur;
      await r.addAttempt({ providerRef: created.providerRef, paymentId, attempt: cur.attempt });
      const next: PaymentRec = { ...cur, status: 'REQUIRES_ACTION', providerRef: created.providerRef, intent: created.intent, updatedAt: this.now };
      await r.savePayment(next); await this.emitStatus(r, next); return next;
    });
  }
  async ensureForRide(rideId: string) { const p = await this.db.tx(r => r.getPaymentByRide(rideId)); return p ? this.ensureProviderPayment(p.id) : undefined; }

  /** New attempt after a failure or an expired intent. A late payment on the OLD attempt is caught as a duplicate capture. */
  async retry(rideId: string, riderId: string) {
    const p = await this.db.tx(async r => {
      const ride = await r.getRide(rideId); if (!ride || ride.riderId !== riderId) throw new DomainError('NOT_FOUND', 'Ride not found');
      const cur = await r.getPaymentByRide(rideId, true); if (!cur) throw new DomainError('NOT_FOUND', 'No payment for this ride');
      const expired = cur.status === 'REQUIRES_ACTION' && !!cur.intent && this.now > cur.intent.expiresAt;
      if (!(cur.status === 'FAILED' || cur.status === 'CANCELLED' || expired)) throw new DomainError('PAYMENT_NOT_RETRYABLE', 'Payment cannot be retried now');
      const next: PaymentRec = { ...cur, status: 'PENDING', attempt: cur.attempt + 1, providerRef: null, intent: null, updatedAt: this.now };
      await r.savePayment(next); await this.emitStatus(r, next); return next;
    });
    return this.ensureProviderPayment(p.id);
  }

  /** Webhook entry point. Throws SignatureError for anything that does not verify. */
  async handleWebhook(raw: Buffer | string, signature: string | undefined) {
    const evt = this.provider.verifyWebhook(raw, signature);
    return this.db.tx(r => this.processEvent(r, evt, 'WEBHOOK'));
  }

  private async processEvent(r: Repo, evt: ProviderEvent, source: string): Promise<string> {
    const isPayment = evt.type.startsWith('payment.');
    // Resolve the target BEFORE recording the event: an event we cannot place yet is not "consumed", so the provider's retry still works
    // (covers a webhook that races ahead of our own write of the provider reference).
    const attempt = isPayment ? await r.getAttempt(evt.providerRef) : undefined;
    if (isPayment && !attempt) return 'UNKNOWN_REFERENCE';
    if (!isPayment && !(await r.getRefund(evt.refundId ?? '', false))) return 'UNKNOWN_REFERENCE';
    if (!(await r.recordPaymentEvent(this.provider.name, evt.providerEventId, evt.type, evt.providerRef, evt))) return 'DUPLICATE';
    let outcome: string;
    switch (evt.type) {
      case 'payment.succeeded': outcome = await this.applyCapture(r, evt, attempt!, source); break;
      case 'payment.failed': outcome = await this.applyFailure(r, attempt!); break;
      default: outcome = await this.settleRefund(r, evt.refundId!, evt.type === 'refund.succeeded' ? 'SUCCEEDED' : 'FAILED', null);
    }
    await r.setPaymentEventOutcome(this.provider.name, evt.providerEventId, outcome);
    return outcome;
  }

  private async applyCapture(r: Repo, evt: ProviderEvent, att: { paymentId: string; attempt: number }, source: string) {
    const pay = (await r.getPayment(att.paymentId, true))!;
    if (evt.amountMinor !== pay.amountMinor) {
      await r.addFinding({ kind: 'AMOUNT_MISMATCH', providerRef: evt.providerRef, details: { expected: pay.amountMinor, got: evt.amountMinor, source } });
      return 'AMOUNT_MISMATCH'; // held for finance review: we do not mark it paid, and we do not guess
    }
    if (CAPTURED.includes(pay.status)) {
      if (pay.providerRef === evt.providerRef) return 'IGNORED';
      await r.postLedger(`dup-capture:${evt.providerRef}`, duplicateCaptureLines(pay.rideId, evt.amountMinor));
      await r.insertRefund({ id: randomUUID(), paymentId: pay.id, providerRef: evt.providerRef, amountMinor: evt.amountMinor, reason: 'duplicate capture', kind: 'DUPLICATE_CAPTURE', status: 'REQUESTED', providerRefundRef: null, requestedBy: 'system', createdAt: this.now });
      return 'DUPLICATE_CAPTURE';
    }
    const next: PaymentRec = { ...pay, status: 'SUCCEEDED', providerRef: evt.providerRef, intent: null, updatedAt: this.now };
    await r.savePayment(next);
    await r.postLedger(`upi-capture:${pay.id}`, upiCaptureLines(pay.rideId, pay.amountMinor, this.cfg.commissionBps));
    await this.emitStatus(r, next); return 'CAPTURED';
  }

  private async applyFailure(r: Repo, att: { paymentId: string; attempt: number }) {
    const pay = (await r.getPayment(att.paymentId, true))!;
    if ((pay.status === 'PENDING' || pay.status === 'REQUIRES_ACTION') && pay.attempt === att.attempt) {
      const next: PaymentRec = { ...pay, status: 'FAILED', intent: null, updatedAt: this.now }; await r.savePayment(next); await this.emitStatus(r, next); return 'FAILED';
    }
    return 'IGNORED'; // stale failure for an old attempt, or the payment already succeeded
  }

  // ---------------- refunds ----------------
  async requestRefund(actorId: string, rideId: string, amountMinor: number, reason: string) {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new DomainError('REFUND_EXCEEDS_PAYMENT', 'Invalid refund amount');
    const refund = await this.db.tx(async r => {
      const pay = await r.getPaymentByRide(rideId, true); if (!pay) throw new DomainError('NOT_FOUND', 'Payment not found');
      if (pay.status !== 'SUCCEEDED' && pay.status !== 'PARTIALLY_REFUNDED') throw new DomainError('INVALID_TRANSITION', 'Only a captured payment can be refunded');
      if (pay.refundedMinor + amountMinor > pay.amountMinor) throw new DomainError('REFUND_EXCEEDS_PAYMENT', 'Refund exceeds the amount paid');
      const x: RefundRec = { id: randomUUID(), paymentId: pay.id, providerRef: pay.providerRef!, amountMinor, reason, kind: 'CUSTOMER', status: 'REQUESTED', providerRefundRef: null, requestedBy: actorId, createdAt: this.now };
      await r.insertRefund(x);
      await r.savePayment({ ...pay, refundedMinor: pay.refundedMinor + amountMinor, updatedAt: this.now }); // reserve the amount so concurrent refunds cannot exceed the payment
      await r.addAudit({ actorId, action: 'REFUND_REQUESTED', targetId: rideId, reason, before: pay.refundedMinor, after: pay.refundedMinor + amountMinor, at: this.now });
      return x;
    });
    await this.sendRefund(refund).catch(() => undefined); // the worker retries if the provider is down
    return refund;
  }

  async sendRefund(x: RefundRec) {
    const res = await this.provider.refund({ refundId: x.id, providerRef: x.providerRef, amountMinor: x.amountMinor }); // idempotent on refundId
    await this.db.tx(async r => {
      const cur = await r.getRefund(x.id, true); if (!cur || cur.status !== 'REQUESTED') return;
      if (res.status === 'PENDING') await r.saveRefund({ ...cur, providerRefundRef: res.providerRefundRef });
      else await this.settleRefund(r, x.id, res.status, res.providerRefundRef);
    });
  }

  private async settleRefund(r: Repo, refundId: string, result: 'SUCCEEDED' | 'FAILED', providerRefundRef: string | null) {
    const x = await r.getRefund(refundId, true); if (!x) return 'UNKNOWN_REFERENCE';
    if (x.status !== 'REQUESTED') return 'IGNORED';
    const pay = (await r.getPayment(x.paymentId, true))!;
    await r.saveRefund({ ...x, status: result, providerRefundRef: providerRefundRef ?? x.providerRefundRef });
    if (result === 'SUCCEEDED') {
      if (x.kind === 'DUPLICATE_CAPTURE') await r.postLedger(`dup-refund:${x.id}`, duplicateRefundLines(pay.rideId, x.amountMinor));
      else {
        await r.postLedger(`refund:${x.id}`, refundLines(pay.rideId, x.amountMinor, this.cfg.commissionBps));
        const done = (await r.listRefunds(pay.id)).filter(f => f.kind === 'CUSTOMER' && (f.status === 'SUCCEEDED' || f.id === x.id)).reduce((a, f) => a + f.amountMinor, 0);
        const next: PaymentRec = { ...pay, status: done >= pay.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED', updatedAt: this.now };
        await r.savePayment(next); await this.emitStatus(r, next);
      }
      return 'REFUNDED';
    }
    if (x.kind === 'CUSTOMER') await r.savePayment({ ...pay, refundedMinor: pay.refundedMinor - x.amountMinor, updatedAt: this.now }); // release the reservation
    else await r.addFinding({ kind: 'DUPLICATE_REFUND_FAILED', providerRef: x.providerRef, details: { refundId: x.id } });
    return 'REFUND_FAILED';
  }

  // ---------------- background work ----------------
  /** Retries provider calls that failed earlier (outage, crash between our write and theirs). */
  async processOutbound() {
    for (const p of await this.db.tx(r => r.paymentsAwaitingProvider(20))) await this.ensureProviderPayment(p.id).catch(() => undefined);
    for (const x of await this.db.tx(r => r.refundsToSend(20))) await this.sendRefund(x).catch(() => undefined);
  }

  /**
   * Compares our records with the provider's. Repairs what is safe (a lost "paid" webhook) through the SAME idempotent path as
   * webhooks, and records everything else as a finding for finance (unique per kind+reference, so re-runs do not duplicate).
   */
  async reconcile(sinceMs = 0) {
    const sum = { checked: 0, repaired: 0, findings: 0 };
    const finding = async (kind: string, providerRef: string, details: unknown) => { if (await this.db.tx(r => r.addFinding({ kind, providerRef, details }))) sum.findings++; };
    for (const p of await this.db.tx(r => r.stalePayments(this.now - (this.cfg.staleMs ?? 120_000), 200))) {
      sum.checked++;
      const theirs = await this.provider.fetchPayment(p.providerRef!);
      if (!theirs) { await finding('MISSING_AT_PROVIDER', p.providerRef!, { paymentId: p.id }); continue; }
      if (theirs.status === 'PENDING') continue;
      const type = theirs.status === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed';
      const out = await this.db.tx(r => this.processEvent(r, { providerEventId: `recon:${p.providerRef}:${theirs.status}`, type, providerRef: p.providerRef!, amountMinor: theirs.amountMinor }, 'RECONCILIATION'));
      if (out === 'CAPTURED' || out === 'FAILED') sum.repaired++;
    }
    for (const t of await this.provider.listPayments(sinceMs))
      if (!(await this.db.tx(r => r.getAttempt(t.providerRef)))) await finding('ORPHAN_AT_PROVIDER', t.providerRef, { status: t.status, amountMinor: t.amountMinor });
    return sum;
  }
}
