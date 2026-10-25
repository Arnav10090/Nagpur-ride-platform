/** Paise -> "₹1,23,456.50" (Indian digit grouping). Integer maths only. */
export function formatINR(minor: number): string {
  const neg = minor < 0; const abs = Math.abs(Math.round(minor)); const rupees = Math.floor(abs / 100), paise = abs % 100;
  const s = String(rupees); const last3 = s.slice(-3), rest = s.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${neg ? '-' : ''}₹${grouped}.${String(paise).padStart(2, '0')}`;
}
/** Accepts what people type ("98765 43210", "+91 98765 43210", "09876543210") and returns the 10 digits, or null. */
export function parsePhone(input: string): string | null {
  let d = input.replace(/\D/g, ''); if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
export const isOtp = (s: string) => /^\d{6}$/.test(s);
/** Vehicle registration as typed by drivers, e.g. "mh 31 ab 1234". */
export const normalizeRegistration = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
export const isRegistration = (s: string) => /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(normalizeRegistration(s));
/** Opens the user's maps app with directions; universal link, so it needs no maps SDK or API key. */
export const navigationUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
export const newKey = (): string => {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'k-' + Date.now().toString(36) + '-' + Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join('-');
};
export const decodeJwtExp = (token: string): number | null => {
  try { const b = token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'); const json = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString(); return JSON.parse(json).exp ?? null; } catch { return null; }
};
export class Store<T extends object> {
  private ls = new Set<() => void>();
  constructor(public state: T) {}
  get = () => this.state;
  set(p: Partial<T>) { this.state = { ...this.state, ...p }; this.ls.forEach(l => l()); }
  subscribe = (l: () => void) => { this.ls.add(l); return () => { this.ls.delete(l); }; };
}
