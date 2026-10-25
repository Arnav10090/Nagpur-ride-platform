import { DomainError } from './errors';

export type RideStatus =
  | 'REQUESTED' | 'SEARCHING' | 'DRIVER_ASSIGNED' | 'DRIVER_ARRIVING'
  | 'DRIVER_ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export type RideCommand =
  | 'START_SEARCH' | 'ASSIGN' | 'DRIVER_EN_ROUTE' | 'ARRIVE' | 'START_TRIP'
  | 'COMPLETE' | 'CANCEL' | 'EXPIRE';

export type Actor = { kind: 'RIDER' | 'DRIVER' | 'SYSTEM'; id: string };

export interface Ride {
  id: string; riderId: string; driverId: string | null;
  status: RideStatus; stateVersion: number;
}

const TABLE: Record<RideCommand, { from: RideStatus[]; to: RideStatus; actor: Actor['kind'][] }> = {
  START_SEARCH:    { from: ['REQUESTED'],       to: 'SEARCHING',       actor: ['SYSTEM'] },
  ASSIGN:          { from: ['SEARCHING'],       to: 'DRIVER_ASSIGNED', actor: ['SYSTEM'] },
  DRIVER_EN_ROUTE: { from: ['DRIVER_ASSIGNED'], to: 'DRIVER_ARRIVING', actor: ['DRIVER'] },
  ARRIVE:          { from: ['DRIVER_ARRIVING'], to: 'DRIVER_ARRIVED',  actor: ['DRIVER'] },
  START_TRIP:      { from: ['DRIVER_ARRIVED'],  to: 'IN_PROGRESS',     actor: ['DRIVER'] },
  COMPLETE:        { from: ['IN_PROGRESS'],     to: 'COMPLETED',       actor: ['DRIVER'] },
  CANCEL: {
    from: ['REQUESTED', 'SEARCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED'],
    to: 'CANCELLED', actor: ['RIDER', 'DRIVER', 'SYSTEM'],
  },
  EXPIRE:          { from: ['SEARCHING'],       to: 'EXPIRED',         actor: ['SYSTEM'] },
};

/** Pure transition: returns a new Ride or throws a stable DomainError. Never accepts a raw status from a client. */
export function transition(ride: Ride, command: RideCommand, actor: Actor, driverId?: string): Ride {
  const rule = TABLE[command];
  // Ownership/actor checks run BEFORE state checks so non-participants learn nothing about ride state.
  if (!rule.actor.includes(actor.kind))
    throw new DomainError('FORBIDDEN', `${actor.kind} cannot ${command}`);
  if (actor.kind === 'RIDER' && actor.id !== ride.riderId)
    throw new DomainError('FORBIDDEN', 'Not your ride');
  if (actor.kind === 'DRIVER' && ride.driverId !== actor.id)
    throw new DomainError('NOT_ASSIGNED_DRIVER', 'Only the assigned driver may perform this action');
  if (!rule.from.includes(ride.status))
    throw new DomainError('INVALID_TRANSITION', `${command} not allowed from ${ride.status}`);
  if (command === 'ASSIGN' && !driverId) throw new DomainError('INVALID_TRANSITION', 'ASSIGN needs a driver');
  return {
    ...ride,
    status: rule.to,
    driverId: command === 'ASSIGN' ? driverId! : ride.driverId,
    stateVersion: ride.stateVersion + 1,
  };
}
