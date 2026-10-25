import { useCallback, useEffect, useRef, useState } from 'react';
import { adminMessage } from './api';

/** Loads data, exposes {data,error,loading,reload}. A newer request always wins over an older, slower one. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [s, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true }); const seq = useRef(0);
  const run = useCallback(() => { const my = ++seq.current; set(x => ({ ...x, loading: true, error: null })); fn().then(d => { if (my === seq.current) set({ data: d, error: null, loading: false }); }, e => { if (my === seq.current) set(x => ({ ...x, error: adminMessage(e), loading: false })); }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}
/** Signs staff out after a period with no interaction. */
export function useIdle(ms: number, onIdle: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return; let t = setTimeout(onIdle, ms); const reset = () => { clearTimeout(t); t = setTimeout(onIdle, ms); };
    const ev = ['pointerdown', 'keydown', 'scroll', 'visibilitychange']; ev.forEach(e => window.addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(t); ev.forEach(e => window.removeEventListener(e, reset)); };
  }, [ms, onIdle, active]);
}
export const useHash = () => {
  const [h, setH] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => { const f = () => setH(window.location.hash.replace(/^#/, '') || '/'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
};
