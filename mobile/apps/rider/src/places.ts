import type { LL } from '@rides/client';
export interface Place { id: string; name: string; at: LL }
/** Approximate landmark coordinates for the pilot; replaced by a real places/search provider once chosen. */
export const LANDMARKS: Place[] = [
  { id: 'station', name: 'Nagpur Railway Station', at: { lat: 21.1497, lng: 79.0806 } },
  { id: 'sitabuldi', name: 'Sitabuldi', at: { lat: 21.1405, lng: 79.083 } },
  { id: 'dharampeth', name: 'Dharampeth', at: { lat: 21.1318, lng: 79.0586 } },
  { id: 'sadar', name: 'Sadar', at: { lat: 21.162, lng: 79.078 } },
  { id: 'itwari', name: 'Itwari', at: { lat: 21.1385, lng: 79.1067 } },
  { id: 'airport', name: 'Dr. Babasaheb Ambedkar Airport', at: { lat: 21.0922, lng: 79.0472 } },
];
export function distanceKm(a: LL, b: LL) { const r = (x: number) => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng); return 6371 * 2 * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2)); }
