import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform as RN } from 'react-native';
import type { LocationFix, Platform, TokenStore, Tokens } from '@rides/client';

const KEY = 'rides.session.v1';
const web = () => RN.OS === 'web' ? (globalThis as any).localStorage as Storage | undefined : undefined;

/** Tokens live in the OS keychain/keystore (SecureStore); the browser build falls back to localStorage for development only. */
const storage: TokenStore = {
  async load() { try { const raw = web() ? web()!.getItem(KEY) : await SecureStore.getItemAsync(KEY); return raw ? (JSON.parse(raw) as Tokens) : null; } catch { return null; } },
  async save(t) { try { const v = t ? JSON.stringify(t) : null; if (web()) { v ? web()!.setItem(KEY, v) : web()!.removeItem(KEY); } else if (v) await SecureStore.setItemAsync(KEY, v); else await SecureStore.deleteItemAsync(KEY); } catch { /* storage failure must never crash the app */ } },
};
const toFix = (p: Location.LocationObject): LocationFix => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyMeters: p.coords.accuracy ?? 50, at: p.timestamp });

export const expoPlatform: Platform = {
  storage,
  location: {
    async requestPermission() { try { return (await Location.requestForegroundPermissionsAsync()).status === 'granted'; } catch { return false; } },
    async current() { return toFix(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })); },
    async watch(onFix, onError) {
      const sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 }, p => onFix(toFix(p)), e => onError(new Error(String(e))));
      return () => sub.remove();
    },
  },
  openUrl: (url: string) => Linking.openURL(url),
};
/** Set EXPO_PUBLIC_API_URL at build time. Production MUST be https. */
export const apiBaseUrl: string = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
