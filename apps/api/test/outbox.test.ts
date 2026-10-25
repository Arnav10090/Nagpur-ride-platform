import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { OutboxWorker } from '../src/domain/outbox';
import { Db, OutboxEvent } from '../src/domain/ports';
import { recipients } from '../src/http/realtime';
import { closePool, makeDb, PG_URL } from './harness';

const impls: ('memory' | 'postgres')[] = PG_URL ? ['memory', 'postgres'] : ['memory'];
afterAll(closePool);

describe('event routing', () => {
  it('only the rider and driver of a ride see its events; offers go to the offered driver only; unknown types go nowhere', () => {
    const e = (type: string, payload: any): OutboxEvent => ({ id: 'x', type, aggregateId: 'r', payload });
    expect(recipients(e('ride.status.changed', { riderId: 'R', driverId: 'D' }))).toEqual(['R', 'D']);
    expect(recipients(e('ride.status.changed', { riderId: 'R', driverId: null }))).toEqual(['R']);
    expect(recipients(e('ride.offer.created', { driverId: 'D', riderId: 'R' }))).toEqual(['D']);
    expect(recipients(e('internal.secret', { riderId: 'R' }))).toEqual([]);
  });
});

describe.each(impls)('outbox worker [%s]', kind => {
  let db: Db, t: number; const seen: OutboxEvent[] = [];
  const emit = (n: number) => db.tx(async r => { for (let i = 0; i < n; i++) await r.emit('ride.status.changed', `ride-${i}`, { n: i }); });
  const collector = { async publish(e: OutboxEvent) { seen.push(e); } };
  beforeEach(async () => { db = await makeDb(kind); t = 1_000_000; seen.length = 0; });

  it('delivers in order and exactly once on repeated ticks', async () => {
    await emit(5); const w = new OutboxWorker(db, collector, () => t);
    expect(await w.tick()).toEqual({ delivered: 5, retried: 0, failed: 0 }); expect(await w.tick()).toEqual({ delivered: 0, retried: 0, failed: 0 });
    expect(seen.map(e => e.payload.n)).toEqual([0, 1, 2, 3, 4]);
  });
  it('respects batch size', async () => {
    await emit(7); const w = new OutboxWorker(db, collector, () => t, { batch: 3 });
    expect((await w.tick()).delivered).toBe(3); expect((await w.tick()).delivered).toBe(3); expect((await w.tick()).delivered).toBe(1);
  });
  it('a failing event is retried with exponential backoff and does not block the others', async () => {
    await emit(3); let fail = true; const ids: string[] = [];
    const pub = { async publish(e: OutboxEvent) { if (e.payload.n === 1 && fail) throw new Error('down'); ids.push(e.id); seen.push(e); } };
    const w = new OutboxWorker(db, pub, () => t, { baseBackoffMs: 1000 });
    expect(await w.tick()).toEqual({ delivered: 2, retried: 1, failed: 0 });
    expect(await w.tick()).toEqual({ delivered: 0, retried: 0, failed: 0 });      // still backing off (2s)
    t += 2001; fail = false; expect((await w.tick()).delivered).toBe(1);          // retried after backoff
    expect(seen.map(e => e.payload.n).sort()).toEqual([0, 1, 2]);
  });
  it('gives up after maxAttempts and dead-letters (FAILED), never retrying again', async () => {
    await emit(1); let calls = 0; const w = new OutboxWorker(db, { async publish() { calls++; throw new Error('always'); } }, () => t, { maxAttempts: 3, baseBackoffMs: 10 });
    for (let i = 0; i < 6; i++) { await w.tick(); t += 10_000; }
    expect(calls).toBe(3);
  });
  it('a hanging publisher is timed out instead of holding the transaction forever', async () => {
    await emit(1); const w = new OutboxWorker(db, { publish: () => new Promise(() => {}) }, () => t, { publishTimeoutMs: 50 });
    expect((await w.tick()).retried).toBe(1);
  });
  it('redelivery keeps the same event id so consumers can de-duplicate', async () => {
    await emit(1); let first: string | undefined; let n = 0;
    const w = new OutboxWorker(db, { async publish(e) { n++; if (n === 1) { first = e.id; throw new Error('x'); } seen.push(e); } }, () => t, { baseBackoffMs: 1 });
    await w.tick(); t += 5000; await w.tick(); expect(seen[0]!.id).toBe(first);
  });
  it('several workers running at once publish every event exactly once', async () => {
    await emit(40); const counts = new Map<string, number>();
    const pub = { async publish(e: OutboxEvent) { await new Promise(r => setTimeout(r, 2)); counts.set(e.id, (counts.get(e.id) ?? 0) + 1); } };
    const ws = Array.from({ length: 4 }, () => new OutboxWorker(db, pub, () => t, { batch: 10 }));
    for (let i = 0; i < 4; i++) await Promise.all(ws.map(w => w.tick()));
    expect(counts.size).toBe(40); expect([...counts.values()].every(c => c === 1)).toBe(true);
  });
});
