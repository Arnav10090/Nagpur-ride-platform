/** Every failure the apps can see is an ApiError; `status` 0 means "could not reach the server". */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) { super(message); this.name = 'ApiError'; }
  get isNetwork() { return this.status === 0; }
}

const MESSAGES: Record<string, string> = {
  NETWORK: 'No connection. Check your internet and try again.',
  OTP_INVALID: 'That code is wrong or has expired.', OTP_THROTTLED: 'Please wait a little before asking for another code.',
  INVALID_PHONE: 'Enter a valid 10-digit mobile number.', ACCOUNT_SUSPENDED: 'This account has been suspended. Please contact support.',
  QUOTE_EXPIRED: 'That fare has expired. We will get you a fresh one.', FORBIDDEN: 'That is not available right now.',
  OFFER_EXPIRED: 'That ride request has expired.', OFFER_NOT_PENDING: 'That ride request is no longer available.', RIDE_NOT_SEARCHING: 'Another driver already took this ride.',
  DRIVER_BUSY: 'You already have an active ride.', INVALID_TRANSITION: 'That step is not possible right now.', NOT_FOUND: 'We could not find that.',
  PAYMENT_NOT_RETRYABLE: 'A payment is already in progress.', IDEMPOTENCY_CONFLICT: 'That vehicle registration is already registered.', VALIDATION_ERROR: 'Please check what you entered.',
  SESSION_INVALID: 'Your session has ended. Please sign in again.', UNAUTHENTICATED: 'Please sign in again.',
};
/** Plain-language text for a failure. Never leaks codes, stack traces or server messages. */
export function userMessage(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? (e.retryable ? 'Something went wrong. Please try again.' : 'Something went wrong.');
  return 'Something went wrong. Please try again.';
}
