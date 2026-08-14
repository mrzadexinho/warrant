// Shared conformance suite for the §8 Outbox (P1): imported relatively by test files
// ONLY, mirrors park-store-conformance.ts. NOT exported from src/index.ts (vitest code
// must not enter the production surface). Both MemoryOutbox and PostgresOutbox must pass
// every case here, including the paramsHash round-trip: the drainer's step-5 equality
// check is worthless if a backend reshapes params on the way through.
import { it, expect, beforeEach } from 'vitest';
import { paramsHash } from '@idriszade/warrant-core';
import type { Outbox, OutboxRow } from '../src/outbox.js';

const PARAMS = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' };

const row = (o: Partial<OutboxRow> = {}): OutboxRow => ({
  requestId: 'conf-req',
  runId: 'conf-run',
  params: PARAMS,
  enqueuedAt: '2026-07-28T10:00:00.000Z',
  ...o,
});

export function runOutboxConformance(
  name: string,
  makeOutbox: () => Promise<Outbox>,
  makeFailingOutbox: () => Promise<Outbox>,
): void {
  let outbox: Outbox;
  beforeEach(async () => { outbox = await makeOutbox(); });

  it(`${name}: listPending on an empty outbox returns ok([])`, async () => {
    const r = await outbox.listPending();
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
  });

  it(`${name}: enqueue then listPending returns the row with every field intact`, async () => {
    const e = await outbox.enqueue(row());
    expect(e.error).toBeNull();
    const r = await outbox.listPending();
    expect(r.error).toBeNull();
    expect(r.data).toEqual([row()]);
  });

  // First write wins, deliberately. The warrant upstream was minted over the params of the
  // FIRST enqueue; letting a re-enqueue swap them under an already-issued warrant would turn
  // a benign retry into a permanent params_mismatch at drain time (fail-closed, but wrong).
  it(`${name}: enqueue is idempotent on requestId: the FIRST params win, exactly one row`, async () => {
    await outbox.enqueue(row({ params: { to: 'first@example.com' }, enqueuedAt: '2026-07-28T10:00:00.000Z' }));
    await outbox.enqueue(row({ params: { to: 'second@example.com' }, enqueuedAt: '2026-07-28T11:00:00.000Z' }));
    const r = await outbox.listPending();
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.params).toEqual({ to: 'first@example.com' });
    expect(r.data![0]!.enqueuedAt).toBe('2026-07-28T10:00:00.000Z');
  });

  it(`${name}: distinct requestIds coexist and come back oldest first`, async () => {
    await outbox.enqueue(row({ requestId: 'conf-req-c', enqueuedAt: '2026-07-28T12:00:00.000Z' }));
    await outbox.enqueue(row({ requestId: 'conf-req-a', enqueuedAt: '2026-07-28T10:00:00.000Z' }));
    await outbox.enqueue(row({ requestId: 'conf-req-b', enqueuedAt: '2026-07-28T11:00:00.000Z' }));
    const r = await outbox.listPending();
    expect(r.data!.map(x => x.requestId)).toEqual(['conf-req-a', 'conf-req-b', 'conf-req-c']);
  });

  it(`${name}: limit truncates to the oldest N`, async () => {
    await outbox.enqueue(row({ requestId: 'conf-req-a', enqueuedAt: '2026-07-28T10:00:00.000Z' }));
    await outbox.enqueue(row({ requestId: 'conf-req-b', enqueuedAt: '2026-07-28T11:00:00.000Z' }));
    await outbox.enqueue(row({ requestId: 'conf-req-c', enqueuedAt: '2026-07-28T12:00:00.000Z' }));
    const r = await outbox.listPending(2);
    expect(r.data!.map(x => x.requestId)).toEqual(['conf-req-a', 'conf-req-b']);
  });

  // The whole §8 step-3 property depends on this: whatever the backend does to params on
  // the way in and out, the hash the drainer recomputes must still equal the one the
  // warrant was signed over.
  it(`${name}: params round-trip preserves paramsHash exactly`, async () => {
    const nested = { to: 'a@example.com', meta: { tags: ['x', 'y'], n: 3, flag: false, none: null } };
    await outbox.enqueue(row({ requestId: 'conf-req-hash', params: nested }));
    const r = await outbox.listPending();
    const stored = r.data!.find(x => x.requestId === 'conf-req-hash')!;
    expect(paramsHash(stored.params)).toBe(paramsHash(nested));
  });

  // A TOP-LEVEL array is the case that actually distinguishes the backends. pg turns a JS array
  // into a Postgres ARRAY literal, not jsonb, so PostgresOutbox.enqueue stringifies and casts
  // explicitly. Without that, enqueue errs 'invalid input syntax for type json' and the row is
  // silently never sent. Every other case here uses an object at the top level and cannot see it.
  it(`${name}: a top-level array params round-trips and preserves paramsHash`, async () => {
    const arrayParams = ['a', { b: 2 }, null, 3];
    const e = await outbox.enqueue(row({ requestId: 'conf-req-arr', params: arrayParams }));
    expect(e.error).toBeNull();
    const r = await outbox.listPending();
    const stored = r.data!.find(x => x.requestId === 'conf-req-arr')!;
    expect(stored.params).toEqual(arrayParams);
    expect(paramsHash(stored.params)).toBe(paramsHash(arrayParams));
  });

  it(`${name}: retire removes exactly the named row and leaves the rest`, async () => {
    await outbox.enqueue(row({ requestId: 'conf-req-a', enqueuedAt: '2026-07-28T10:00:00.000Z' }));
    await outbox.enqueue(row({ requestId: 'conf-req-b', enqueuedAt: '2026-07-28T11:00:00.000Z' }));
    const gone = await outbox.retire('conf-req-a');
    expect(gone.error).toBeNull();
    const r = await outbox.listPending();
    expect(r.data!.map(x => x.requestId)).toEqual(['conf-req-b']);
  });

  // Absence is not an error, the same rule ParkStore.get follows: the drainer retires
  // best-effort and must not turn a concurrent cleanup into a failure.
  it(`${name}: retiring an absent row is ok, not an error`, async () => {
    const r = await outbox.retire('conf-req-never-existed');
    expect(r.error).toBeNull();
  });

  // Retire then re-enqueue is how a genuinely new action reuses a requestId. If retire left a
  // tombstone, first-write-wins would silently reject the new row and it would never send.
  it(`${name}: a retired requestId can be enqueued again`, async () => {
    await outbox.enqueue(row({ params: { to: 'first@example.com' } }));
    await outbox.retire('conf-req');
    await outbox.enqueue(row({ params: { to: 'second@example.com' } }));
    const r = await outbox.listPending();
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.params).toEqual({ to: 'second@example.com' });
  });

  it(`${name}: enqueuedAt round-trips the exact ISO string`, async () => {
    await outbox.enqueue(row({ requestId: 'conf-req-ts', enqueuedAt: '2026-07-28T10:00:00.123Z' }));
    const r = await outbox.listPending();
    expect(r.data!.find(x => x.requestId === 'conf-req-ts')!.enqueuedAt).toBe('2026-07-28T10:00:00.123Z');
  });

  it(`${name}: a backend that errors returns typed err, never throws, never partial`, async () => {
    const failing = await makeFailingOutbox();
    const enqueueResult = await failing.enqueue(row());
    expect(enqueueResult.error).not.toBeNull();
    expect(enqueueResult.error!.type).toBe('transient');
    expect(enqueueResult.error!.code).toBe('db_error');

    const listResult = await failing.listPending();
    expect(listResult.error).not.toBeNull();
    expect(listResult.error!.code).toBe('db_error');
    expect(listResult.data).toBeNull();

    const retireResult = await failing.retire('conf-req');
    expect(retireResult.error).not.toBeNull();
    expect(retireResult.error!.code).toBe('db_error');
  });
}
