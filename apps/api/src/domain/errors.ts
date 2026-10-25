export type ErrorCode =
  | 'INVALID_TRANSITION' | 'NOT_ASSIGNED_DRIVER' | 'FORBIDDEN' | 'OFFER_EXPIRED'
  | 'OFFER_NOT_PENDING' | 'RIDE_NOT_SEARCHING' | 'QUOTE_EXPIRED' | 'NOT_FOUND'
  | 'REFUND_EXCEEDS_PAYMENT' | 'PAYMENT_NOT_RETRYABLE' | 'DRIVER_BUSY' | 'LEDGER_UNBALANCED' | 'IDEMPOTENCY_CONFLICT';

/** Stable, structured domain error; the HTTP layer maps all of these to 409/403/404. */
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = false) {
    super(message);
  }
  toEnvelope(requestId: string) {
    return { error: { code: this.code, message: this.message, retryable: this.retryable }, meta: { requestId } };
  }
}
