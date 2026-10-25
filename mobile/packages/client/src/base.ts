import { ApiClient } from './api';
import { ApiError, userMessage } from './errors';
import { Connection, RealtimeClient, LiveEvent } from './realtime';
import { Platform, ClientConfig } from './platform';
import { Store } from './util';

/** Shared plumbing: API + socket + a state store + guarded actions. */
export abstract class BaseController<S extends { auth: 'UNKNOWN' | 'LOGGED_OUT' | 'LOGGED_IN'; busy: boolean; error: string | null; connection: Connection }> {
  readonly api: ApiClient; readonly realtime: RealtimeClient; protected timer?: ReturnType<typeof setInterval>;
  constructor(protected platform: Platform, protected cfg: ClientConfig, readonly store: Store<S>) {
    this.api = new ApiClient({ baseUrl: cfg.baseUrl, store: platform.storage, fetchImpl: cfg.fetchImpl, onSessionExpired: () => { void this.onSessionExpired(); } });
    this.realtime = new RealtimeClient({ baseUrl: cfg.baseUrl, api: this.api, ioImpl: cfg.ioImpl, onEvent: e => { void this.onEvent(e).catch(() => undefined); },
      onConnection: c => { this.store.set({ connection: c } as Partial<S>); if (c === 'CONNECTED' && this.store.get().auth === 'LOGGED_IN') void this.resync().catch(() => undefined); } });
  }
  protected abstract onEvent(e: LiveEvent): Promise<void>;
  protected abstract resync(): Promise<void>;
  protected abstract tick(): Promise<void>;
  protected abstract reset(): void;
  protected async onSessionExpired() { this.stopWork(); this.reset(); this.store.set({ auth: 'LOGGED_OUT', error: userMessage(new ApiError(401, 'SESSION_INVALID', '')) } as Partial<S>); }

  /** Runs a user action: busy flag, friendly error, never throws. Returns true on success. */
  protected async run(fn: () => Promise<void>): Promise<boolean> {
    this.store.set({ busy: true, error: null } as Partial<S>);
    try { await fn(); return true; }
    catch (e) { if (!(e instanceof ApiError && e.code === 'SESSION_INVALID')) this.store.set({ error: userMessage(e) } as Partial<S>); return false; }
    finally { this.store.set({ busy: false } as Partial<S>); }
  }
  protected startWork() {
    this.realtime.start(); clearInterval(this.timer);
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.cfg.pollMs ?? 5000);
  }
  protected stopWork() { clearInterval(this.timer); this.timer = undefined; this.realtime.stop(); }
  clearError() { this.store.set({ error: null } as Partial<S>); }
  stop() { this.stopWork(); }
}
