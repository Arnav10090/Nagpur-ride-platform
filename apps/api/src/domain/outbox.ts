import { Db, OutboxEvent } from './ports';

export interface Publisher { publish(e: OutboxEvent): Promise<void> }
export interface OutboxOptions { batch?: number; maxAttempts?: number; baseBackoffMs?: number; publishTimeoutMs?: number }

/**
 * Transactional-outbox relay. Events were written in the same transaction as the state change, so none can be lost.
 * Delivery is AT-LEAST-ONCE: a crash after publish but before commit re-delivers, so consumers de-duplicate on `id`
 * and ignore a `stateVersion` they have already seen. Several workers may run: SKIP LOCKED keeps them from colliding.
 * The claim transaction stays open while publishing, so publishers must be fast (in-process fan-out). For slow network
 * sinks (push providers) use a publisher that only enqueues.
 */
export class OutboxWorker {
  constructor(private db: Db, private pub: Publisher, private now: () => number = Date.now, private o: OutboxOptions = {}) {}

  async tick() {
    const { batch = 50, maxAttempts = 6, baseBackoffMs = 1000, publishTimeoutMs = 5000 } = this.o;
    return this.db.tx(async r => {
      const stats = { delivered: 0, retried: 0, failed: 0 };
      for (const e of await r.claimOutbox(batch, this.now())) {
        try {
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([this.pub.publish({ id: e.id, type: e.type, aggregateId: e.aggregateId, payload: e.payload }),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('publish timeout')), publishTimeoutMs); })]).finally(() => clearTimeout(timer));
          await r.markOutbox(e.id, 'DELIVERED', e.attempts + 1); stats.delivered++;
        } catch {
          const attempts = e.attempts + 1;
          if (attempts >= maxAttempts) { await r.markOutbox(e.id, 'FAILED', attempts); stats.failed++; } // dead-letter: needs operator attention
          else { await r.markOutbox(e.id, 'PENDING', attempts, this.now() + baseBackoffMs * 2 ** attempts); stats.retried++; }
        }
      }
      return stats;
    });
  }
}
