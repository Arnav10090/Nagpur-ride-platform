export type Role = 'SUPPORT' | 'OPS_ADMIN' | 'FINANCE_ADMIN' | 'SUPER_ADMIN';
export interface Summary { pendingDrivers: number; onlineDrivers: number; activeRides: number; openFindings: number; openPayments: number }
export interface DriverRow { userId: string; phone: string; registration: string; category: string; verification: 'PENDING' | 'APPROVED' | 'REJECTED'; accountStatus: 'ACTIVE' | 'SUSPENDED' | string; online: boolean }
export interface RideRow { id: string; status: string; createdAt: number; paymentMethod: string | null; fareMinor: number | null; paymentStatus: string | null; riderPhone: string | null; driverPhone: string | null }
export interface Refund { id: string; amountMinor: number; kind: string; status: string; reason: string; createdAt: number }
export interface RideDetail { id: string; status: string; stateVersion: number; paymentMethod: string | null; pickup: { lat: number; lng: number } | null; destination: { lat: number; lng: number } | null;
  estimatedFareMinor: number | null; finalFareMinor: number | null; rider: { phone: string | null }; driver: { phone: string | null; registration: string | null; category: string | null } | null;
  timeline: { type: string; at: number; stateVersion: number }[]; payment: { status: string; amountMinor: number; attempt: number; refundedMinor: number; refunds: Refund[] } | null;
  ledger: { transactionId: string; account: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: number }[] }
export interface Finding { id: string; kind: string; providerRef: string; details: unknown; status: 'OPEN' | 'RESOLVED'; resolvedBy?: string | null; resolvedNote?: string | null; resolvedAt?: number | null }
export interface AuditRow { actorId: string; action: string; targetId: string; reason: string; before: unknown; after: unknown; at: number }

const OPS: Role[] = ['OPS_ADMIN', 'SUPER_ADMIN']; const FIN: Role[] = ['FINANCE_ADMIN', 'SUPER_ADMIN'];
/** What each role should SEE. The server enforces the same matrix; hiding a control is convenience, never security. */
export const PERMS = {
  drivers: ['SUPPORT', ...OPS] as Role[], reviewDrivers: OPS, rides: ['SUPPORT', 'OPS_ADMIN', 'FINANCE_ADMIN', 'SUPER_ADMIN'] as Role[],
  finance: FIN, audit: [...OPS, 'FINANCE_ADMIN'] as Role[],
};
export const can = (role: Role | null, list: Role[]) => !!role && list.includes(role);
