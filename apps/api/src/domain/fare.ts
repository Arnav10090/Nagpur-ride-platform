/** All money is integer paise (INR minor units). Rates are placeholders pending the PRD §19.1 pricing decision. */
export interface PricingRule {
  version: number; baseMinor: number; perKmMinor: number; perMinMinor: number;
  minimumMinor: number; cancellationFeeMinor: number; commissionBps: number;
}
export interface FareBreakdown {
  baseMinor: number; distanceMinor: number; timeMinor: number;
  minimumAdjustmentMinor: number; totalMinor: number; pricingVersion: number;
}

const divRound = (num: number, den: number) => Math.floor((2 * num + den) / (2 * den)); // half-up, integers only

export function calculateFare(rule: PricingRule, distanceMeters: number, durationSeconds: number): FareBreakdown {
  if (!Number.isInteger(distanceMeters) || !Number.isInteger(durationSeconds) || distanceMeters < 0 || durationSeconds < 0)
    throw new RangeError('distance and duration must be non-negative integers');
  const distanceMinor = divRound(rule.perKmMinor * distanceMeters, 1000);
  const timeMinor = divRound(rule.perMinMinor * durationSeconds, 60);
  const subtotal = rule.baseMinor + distanceMinor + timeMinor;
  const totalMinor = Math.max(subtotal, rule.minimumMinor);
  return { baseMinor: rule.baseMinor, distanceMinor, timeMinor,
    minimumAdjustmentMinor: totalMinor - subtotal, totalMinor, pricingVersion: rule.version };
}

export const commissionMinor = (fareMinor: number, bps: number) => divRound(fareMinor * bps, 10_000);
