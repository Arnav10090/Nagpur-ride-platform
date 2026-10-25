import { TokenStore } from './api';
export interface LocationFix { lat: number; lng: number; accuracyMeters: number; at: number }
export interface LocationService {
  requestPermission(): Promise<boolean>;
  current(): Promise<LocationFix>;
  /** Starts continuous updates; resolves to a function that stops them. */
  watch(onFix: (f: LocationFix) => void, onError: (e: Error) => void): Promise<() => void>;
}
/** Everything device-specific. Apps provide Expo implementations; tests provide fakes. */
export interface Platform { storage: TokenStore; location: LocationService; openUrl(url: string): Promise<void> }
export interface ClientConfig { baseUrl: string; pollMs?: number; fetchImpl?: typeof fetch; ioImpl?: any }
