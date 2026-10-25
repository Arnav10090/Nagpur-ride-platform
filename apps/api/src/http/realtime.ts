import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import { OutboxEvent } from '../domain/ports';
import { Publisher } from '../domain/outbox';
import { AuthService, Principal } from './auth';

export interface LiveSink extends Publisher { emitToUser(userId: string, type: string, payload: unknown): void }
export const noopSink: LiveSink = { async publish() {}, emitToUser() {} };

/** Who may see an event. Clients never choose rooms; they are only ever placed in their own `user:<id>` room. */
export function recipients(e: OutboxEvent): string[] {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'ride.status.changed': case 'ride.assigned': case 'payment.status.changed': return [p.riderId, p.driverId].filter(Boolean);
    case 'ride.offer.created': case 'ride.offer.invalidated': return [p.driverId].filter(Boolean);
    default: return []; // unknown event types are never broadcast
  }
}

export class LiveHub implements LiveSink {
  private io?: Server; private sockets = new Set<Socket>();
  attach(server: HttpServer, auth: AuthService) {
    this.io = new Server(server, { cors: { origin: false }, serveClient: false });
    this.auth = auth;
    this.io.use(async (socket, next) => {
      try { socket.data.user = await auth.verify(String(socket.handshake.auth?.token ?? '')); next(); }
      catch { next(new Error('UNAUTHENTICATED')); }
    });
    this.io.on('connection', socket => {
      const u = socket.data.user as Principal; socket.join(`user:${u.id}`); this.sockets.add(socket);
      socket.on('disconnect', () => this.sockets.delete(socket));
    });
  }
  private auth?: AuthService;
  async publish(e: OutboxEvent) {
    if (!this.io) throw new Error('realtime not attached'); // keep the event pending until the hub is up
    for (const id of new Set(recipients(e))) this.io.to(`user:${id}`).emit(e.type, { eventId: e.id, rideId: e.aggregateId, ...e.payload });
  }
  emitToUser(userId: string, type: string, payload: unknown) { this.io?.to(`user:${userId}`).emit(type, payload); }
  /** Drops sockets whose access token has expired or whose account is no longer active. Clients reconnect with a fresh token. */
  async revalidate() {
    for (const s of [...this.sockets]) {
      try { const u = await this.auth!.verify(String(s.handshake.auth?.token ?? '')); s.data.user = u; }
      catch { s.disconnect(true); }
    }
  }
  close() { return new Promise<void>(res => (this.io ? this.io.close(() => res()) : res())); }
}
