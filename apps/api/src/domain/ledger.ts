import { DomainError } from './errors';
import { commissionMinor } from './fare';

export interface LedgerEntry { transactionId: string; account: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: number }

/** Append-only, balanced, idempotent per transactionId. Corrections are compensating transactions. */
export class Ledger {
  private entries: LedgerEntry[] = [];
  private seen = new Set<string>();

  post(transactionId: string, lines: Omit<LedgerEntry, 'transactionId'>[]): boolean {
    if (this.seen.has(transactionId)) return false; // duplicate -> no second financial effect
    const sum = (d: string) => lines.filter(l => l.direction === d).reduce((a, l) => a + l.amountMinor, 0);
    if (lines.some(l => !Number.isInteger(l.amountMinor) || l.amountMinor <= 0) || sum('DEBIT') !== sum('CREDIT'))
      throw new DomainError('LEDGER_UNBALANCED', `Transaction ${transactionId} is not balanced`);
    lines.forEach(l => this.entries.push(Object.freeze({ transactionId, ...l })));
    this.seen.add(transactionId);
    return true;
  }
  balance(account: string) {
    return this.entries.filter(e => e.account === account)
      .reduce((a, e) => a + (e.direction === 'CREDIT' ? e.amountMinor : -e.amountMinor), 0);
  }
  all(): readonly LedgerEntry[] { return this.entries; }
  totals() {
    const t = (d: string) => this.entries.filter(e => e.direction === d).reduce((a, e) => a + e.amountMinor, 0);
    return { debit: t('DEBIT'), credit: t('CREDIT') };
  }

  /** PRD §11.4 cash-ride example: rider obligation DR fare; driver payable CR fare-commission; commission CR. */
  recordCashRide(rideId: string, fareMinor: number, commissionBps: number): boolean {
    return this.post(`cash-ride:${rideId}`, cashRideLines(rideId, fareMinor, commissionBps));
  }
}

export function cashRideLines(rideId: string, fareMinor: number, commissionBps: number): Omit<LedgerEntry, 'transactionId'>[] {
  const c = commissionMinor(fareMinor, commissionBps);
  const lines: Omit<LedgerEntry, 'transactionId'>[] = [
    { account: `rider_cash_obligation:${rideId}`, direction: 'DEBIT', amountMinor: fareMinor },
    { account: `driver_payable:${rideId}`, direction: 'CREDIT', amountMinor: fareMinor - c },
  ];
  if (c > 0) lines.push({ account: 'platform_commission', direction: 'CREDIT', amountMinor: c });
  return lines;
}

type Line = Omit<LedgerEntry, 'transactionId'>;
const mk = (...ls: Line[]): Line[] => ls.filter(l => l.amountMinor > 0); // zero-value lines (e.g. 0 commission) are dropped
/** UPI capture confirmed: the provider owes us the fare; driver and platform shares are recognised. */
export function upiCaptureLines(rideId: string, fareMinor: number, bps: number): Line[] {
  const c = commissionMinor(fareMinor, bps);
  return mk({ account: 'provider_receivable', direction: 'DEBIT', amountMinor: fareMinor },
    { account: `driver_payable:${rideId}`, direction: 'CREDIT', amountMinor: fareMinor - c },
    { account: 'platform_commission', direction: 'CREDIT', amountMinor: c });
}
/** Customer refund: a compensating entry that reverses the driver/platform split proportionally (history is never edited). */
export function refundLines(rideId: string, amountMinor: number, bps: number): Line[] {
  const c = commissionMinor(amountMinor, bps);
  return mk({ account: `driver_payable:${rideId}`, direction: 'DEBIT', amountMinor: amountMinor - c },
    { account: 'platform_commission', direction: 'DEBIT', amountMinor: c },
    { account: 'provider_receivable', direction: 'CREDIT', amountMinor });
}
/** The rider paid twice: the extra receipt is a liability to the rider until it is refunded. */
export const duplicateCaptureLines = (rideId: string, amountMinor: number): Line[] =>
  mk({ account: 'provider_receivable', direction: 'DEBIT', amountMinor }, { account: `unapplied_receipts:${rideId}`, direction: 'CREDIT', amountMinor });
export const duplicateRefundLines = (rideId: string, amountMinor: number): Line[] =>
  mk({ account: `unapplied_receipts:${rideId}`, direction: 'DEBIT', amountMinor }, { account: 'provider_receivable', direction: 'CREDIT', amountMinor });

/**
 * Cancellation fee: the rider pays a fee; if a driver was assigned, they receive the fee minus commission.
 * If no driver was assigned, the fee goes entirely to the platform.
 */
export function cancellationFeeLines(rideId: string, feeMinor: number, bps: number, hasDriver: boolean): Line[] {
  if (feeMinor <= 0) return [];
  if (!hasDriver) {
    // No driver assigned: entire fee goes to platform
    return mk(
      { account: `rider_cancellation_fee:${rideId}`, direction: 'DEBIT', amountMinor: feeMinor },
      { account: 'platform_commission', direction: 'CREDIT', amountMinor: feeMinor },
    );
  }
  const c = commissionMinor(feeMinor, bps);
  return mk(
    { account: `rider_cancellation_fee:${rideId}`, direction: 'DEBIT', amountMinor: feeMinor },
    { account: `driver_payable:${rideId}`, direction: 'CREDIT', amountMinor: feeMinor - c },
    { account: 'platform_commission', direction: 'CREDIT', amountMinor: c },
  );
}

