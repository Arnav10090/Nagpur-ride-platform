export class SignatureError extends Error { constructor(m: string) { super(m); this.name = 'SignatureError'; } }
export class ProviderUnavailable extends Error { constructor(m = 'payment provider unavailable') { super(m); this.name = 'ProviderUnavailable'; } }

export interface ProviderEvent {
  providerEventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed';
  providerRef: string; amountMinor: number;
  /** Our own refund id, echoed back by the provider (refund events only). */
  refundId?: string;
}
export interface ProviderPayment { providerRef: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; amountMinor: number }

/** Everything the platform needs from a UPI gateway. A real provider (Razorpay, Cashfree, ...) implements exactly this. */
export interface PaymentProvider {
  readonly name: string;
  /** MUST be idempotent on `idempotencyKey` (calling twice returns the same providerRef). */
  createPayment(req: { idempotencyKey: string; rideId: string; amountMinor: number }): Promise<{ providerRef: string; intent: { upiUri: string; expiresAt: number } }>;
  /** Verifies authenticity + freshness of a webhook from the RAW body. Throws SignatureError. */
  verifyWebhook(rawBody: Buffer | string, signatureHeader: string | undefined): ProviderEvent;
  fetchPayment(providerRef: string): Promise<ProviderPayment | undefined>;
  /** Payments created since `sinceMs`, for reconciliation (detecting orphans we never recorded). */
  listPayments(sinceMs: number): Promise<ProviderPayment[]>;
  /** MUST be idempotent on `refundId`. */
  refund(req: { refundId: string; providerRef: string; amountMinor: number }): Promise<{ providerRefundRef: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }>;
}
