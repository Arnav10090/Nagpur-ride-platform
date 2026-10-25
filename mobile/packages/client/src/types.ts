export type LL = { lat: number; lng: number };
export type RideStatus = 'REQUESTED' | 'SEARCHING' | 'DRIVER_ASSIGNED' | 'DRIVER_ARRIVING' | 'DRIVER_ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export interface Quote { id: string; fare: { baseMinor: number; distanceMinor: number; timeMinor: number; minimumAdjustmentMinor: number; totalMinor: number }; expiresAt: number; pickup: LL; destination: LL }
export interface RideView { id: string; status: RideStatus; stateVersion: number; paymentMethod: 'CASH' | 'UPI' | null; pickup: LL | null; destination: LL | null;
  estimatedFareMinor: number | null; finalFareMinor: number | null; vehicle: { category: string; registration: string } | null }
export interface PaymentView { status: string; amountMinor: number; currency: string; attempt: number; refundedMinor: number; intent: { upiUri: string; expiresAt: number } | null }
export interface RideSummary { id: string; status: RideStatus; createdAt: number; paymentMethod: 'CASH' | 'UPI' | null; fareMinor: number | null; paymentStatus: string | null }
export interface OfferView { id: string; rideId: string; expiresAt: number; pickup: LL }
export interface Tokens { accessToken: string; refreshToken: string }
export const TERMINAL: RideStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];
