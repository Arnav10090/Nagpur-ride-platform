import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Store } from '@rides/client';
export function useStore<T extends object>(store: Store<T>): T { return useSyncExternalStore(store.subscribe, store.get, store.get); }
/** Re-renders twice a second so countdowns stay honest; `now` should be the server-corrected clock. */
export function useNow(now: () => number, everyMs = 500) { const [t, setT] = useState(now()); useEffect(() => { const i = setInterval(() => setT(now()), everyMs); return () => clearInterval(i); }, [now, everyMs]); return t; }
