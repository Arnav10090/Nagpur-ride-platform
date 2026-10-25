import { DispatchService } from '../domain/dispatch';
import { OutboxWorker } from '../domain/outbox';
import { PaymentService } from '../domain/payments/service';
import { LiveHub } from './realtime';

/** Periodic jobs with an overlap guard (a slow tick is skipped, never stacked). */
export class Workers {
  private timers: ReturnType<typeof setInterval>[] = []; private busy = new Set<string>();
  constructor(private dispatch: DispatchService, private outbox: OutboxWorker, private hub: LiveHub, private payments: PaymentService, private log = console.error) {}
  private every(name: string, ms: number, fn: () => Promise<unknown>) {
    this.timers.push(setInterval(async () => {
      if (this.busy.has(name)) return; this.busy.add(name);
      try { await fn(); } catch (e) { this.log(`[worker:${name}]`, (e as Error).message); } finally { this.busy.delete(name); }
    }, ms));
  }
  start() {
    this.every('outbox', 300, () => this.outbox.tick());
    this.every('offer-sweep', 1000, () => this.dispatch.sweep());
    this.every('payments', 2000, () => this.payments.processOutbound());
    this.every('reconcile', 60_000, () => this.payments.reconcile(Date.now() - 24 * 3600_000));
    this.every('socket-revalidate', 30_000, () => this.hub.revalidate());
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
}
