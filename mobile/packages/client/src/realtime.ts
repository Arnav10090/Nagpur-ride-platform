import { io, Socket } from 'socket.io-client';
import { ApiClient } from './api';

export interface LiveEvent { type: string; data: any }
export type Connection = 'CONNECTED' | 'DISCONNECTED';

/**
 * Socket connection that survives bad networks: reconnects with exponential backoff, always presents a FRESH access token,
 * drops duplicate deliveries (the server is at-least-once), and tells the app when it is back so it can resync from REST.
 * The socket is only ever a hint that something changed; REST is the source of truth.
 */
export class RealtimeClient {
  private socket?: Socket; private seen: string[] = []; private stopped = true; private attempt = 0; private timer?: ReturnType<typeof setTimeout>;
  constructor(private o: { baseUrl: string; api: ApiClient; onEvent: (e: LiveEvent) => void; onConnection: (c: Connection) => void; ioImpl?: typeof io }) {}

  start() { if (!this.stopped) return; this.stopped = false; void this.open(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.removeAllListeners(); this.socket?.close(); this.socket = undefined; this.o.onConnection('DISCONNECTED'); }

  private async open() {
    if (this.stopped) return;
    const token = await this.o.api.accessToken();
    if (!token) return this.retry();
    const s = (this.o.ioImpl ?? io)(this.o.baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }); this.socket = s;
    s.on('connect', () => { this.attempt = 0; this.o.onConnection('CONNECTED'); });
    s.on('disconnect', () => { this.o.onConnection('DISCONNECTED'); this.retry(); });
    s.on('connect_error', () => { this.o.onConnection('DISCONNECTED'); s.close(); this.retry(); });
    s.onAny((type: string, data: any) => {
      const id = data?.eventId as string | undefined;
      if (id) { if (this.seen.includes(id)) return; this.seen.push(id); if (this.seen.length > 500) this.seen.shift(); }
      this.o.onEvent({ type, data });
    });
  }
  private retry() {
    if (this.stopped) return; clearTimeout(this.timer);
    const delay = Math.min(15_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5); // jittered backoff
    this.timer = setTimeout(() => { this.socket?.removeAllListeners(); this.socket?.close(); void this.open(); }, delay);
  }
}
