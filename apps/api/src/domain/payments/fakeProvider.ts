import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PaymentProvider, ProviderEvent, ProviderPayment, ProviderUnavailable, SignatureError } from './provider';

type Held = ProviderPayment & { key: string; rideId: string; createdAt: number };

/**
 * An in-process stand-in for a UPI gateway that behaves like a real one:
 * HMAC-signed webhooks with a timestamp, idempotent create/refund, and controllable misbehaviour
 * (outages, async refunds, lost/duplicated/forged webhooks) so the platform can be tested against failure.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  payments = new Map<string, Held>(); private byKey = new Map<string, string>(); private seq = 0;
  refunds = new Map<string, { refundRef: string; providerRef: string; amountMinor: number; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>();
  /** Make the next N createPayment calls fail as if the gateway were down. */
  failCreate = 0;
  refundMode: 'SYNC_SUCCESS' | 'ASYNC' | 'FAIL' = 'SYNC_SUCCESS';
  createCalls = 0;
  constructor(private o: { secret: string; now: () => number; toleranceSec?: number }) {}

  async createPayment(req: { idempotencyKey: string; rideId: string; amountMinor: number }) {
    this.createCalls++;
    if (this.failCreate > 0) { this.failCreate--; throw new ProviderUnavailable(); }
    let ref = this.byKey.get(req.idempotencyKey);
    if (!ref) {
      ref = `fpay_${++this.seq}_${randomUUID().slice(0, 8)}`; this.byKey.set(req.idempotencyKey, ref);
      this.payments.set(ref, { providerRef: ref, status: 'PENDING', amountMinor: req.amountMinor, key: req.idempotencyKey, rideId: req.rideId, createdAt: this.o.now() });
    }
    const p = this.payments.get(ref)!;
    return { providerRef: ref, intent: { upiUri: `upi://pay?pa=fake@upi&pn=NagpurRides&am=${(p.amountMinor / 100).toFixed(2)}&cu=INR&tr=${ref}`, expiresAt: this.o.now() + 10 * 60_000 } };
  }
  async fetchPayment(ref: string) { const p = this.payments.get(ref); return p && { providerRef: p.providerRef, status: p.status, amountMinor: p.amountMinor }; }
  async listPayments(since: number) { return [...this.payments.values()].filter(p => p.createdAt >= since).map(p => ({ providerRef: p.providerRef, status: p.status, amountMinor: p.amountMinor })); }
  async refund(req: { refundId: string; providerRef: string; amountMinor: number }) {
    let r = this.refunds.get(req.refundId);
    if (!r) { r = { refundRef: `frf_${this.refunds.size + 1}_${randomUUID().slice(0, 6)}`, providerRef: req.providerRef, amountMinor: req.amountMinor,
      status: this.refundMode === 'SYNC_SUCCESS' ? 'SUCCEEDED' : this.refundMode === 'FAIL' ? 'FAILED' : 'PENDING' }; this.refunds.set(req.refundId, r); }
    return { providerRefundRef: r.refundRef, status: r.status };
  }

  // ---- webhook signing / verification (same scheme a real gateway uses) ----
  signature(body: string, atSec = Math.floor(this.o.now() / 1000), secret = this.o.secret) {
    return `t=${atSec},v1=${createHmac('sha256', secret).update(`${atSec}.${body}`).digest('hex')}`;
  }
  verifyWebhook(raw: Buffer | string, header: string | undefined): ProviderEvent {
    const body = typeof raw === 'string' ? raw : raw.toString('utf8');
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? ''); if (!m) throw new SignatureError('missing or malformed signature');
    const t = Number(m[1]); if (Math.abs(this.o.now() / 1000 - t) > (this.o.toleranceSec ?? 300)) throw new SignatureError('timestamp outside tolerance (replay?)');
    const expect = createHmac('sha256', this.o.secret).update(`${t}.${body}`).digest(); const got = Buffer.from(m[2]!, 'hex');
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new SignatureError('signature mismatch');
    let j: any; try { j = JSON.parse(body); } catch { throw new SignatureError('malformed body'); }
    if (typeof j?.id !== 'string' || typeof j?.type !== 'string' || typeof j?.data?.providerRef !== 'string' || !Number.isInteger(j?.data?.amountMinor)) throw new SignatureError('malformed event');
    if (!['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed'].includes(j.type)) throw new SignatureError('unknown event type');
    return { providerEventId: j.id, type: j.type, providerRef: j.data.providerRef, amountMinor: j.data.amountMinor, refundId: j.data.refundId };
  }

  // ---- test / dev controls: what the "gateway" does in the outside world ----
  signedEvent(e: { type: ProviderEvent['type']; providerRef: string; amountMinor: number; refundId?: string; eventId?: string }) {
    const rawBody = JSON.stringify({ id: e.eventId ?? `evt_${randomUUID()}`, type: e.type, data: { providerRef: e.providerRef, amountMinor: e.amountMinor, refundId: e.refundId } });
    return { rawBody, signature: this.signature(rawBody) };
  }
  /** The customer pays (or the bank declines). Updates the gateway's own records and returns the webhook it would send. */
  settle(providerRef: string, outcome: 'SUCCEEDED' | 'FAILED', o: { amountMinor?: number; eventId?: string } = {}) {
    const p = this.payments.get(providerRef)!; p.status = outcome;
    return this.signedEvent({ type: outcome === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed', providerRef, amountMinor: o.amountMinor ?? p.amountMinor, eventId: o.eventId });
  }
  settleRefund(refundId: string, outcome: 'SUCCEEDED' | 'FAILED') {
    const r = this.refunds.get(refundId)!; r.status = outcome;
    return this.signedEvent({ type: outcome === 'SUCCEEDED' ? 'refund.succeeded' : 'refund.failed', providerRef: r.providerRef, amountMinor: r.amountMinor, refundId });
  }
  /** A payment exists at the gateway that the platform never recorded (e.g. created, then our DB write was lost). */
  injectOrphan(amountMinor: number, status: 'SUCCEEDED' | 'PENDING' = 'SUCCEEDED') {
    const ref = `fpay_orphan_${randomUUID().slice(0, 8)}`; this.payments.set(ref, { providerRef: ref, status, amountMinor, key: ref, rideId: 'unknown', createdAt: this.o.now() }); return ref;
  }
}
