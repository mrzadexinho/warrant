// Shared conformance suite: imported relatively by test files ONLY, mirrors
// warrant-ledger/tests/conformance.ts. NOT exported from src/index.ts (vitest code
// must not enter the production surface).
import { it, expect, beforeEach } from 'vitest';
import type { ParkStore, ParkRecord } from '../src/park-store.js';

const rec = (o: Partial<ParkRecord> = {}): ParkRecord => ({
  reviewId: 'conf-review', runId: 'conf-run', callId: 'conf-call',
  eveRequestId: 'conf-req', continuationToken: 'conf-token',
  parkedAt: '2026-07-26T10:00:00.000Z', ...o,
});

export function runParkStoreConformance(
  name: string,
  makeStore: () => Promise<ParkStore>,
  makeFailingStore: () => Promise<ParkStore>,
): void {
  let store: ParkStore;
  beforeEach(async () => { store = await makeStore(); });

  it(`${name}: get on an absent reviewId returns ok(null)`, async () => {
    const r = await store.get('missing-review');
    expect(r.error).toBeNull();
    expect(r.data).toBeNull();
  });

  it(`${name}: put then get returns the record with every field intact`, async () => {
    await store.put(rec());
    const r = await store.get('conf-review');
    expect(r.error).toBeNull();
    expect(r.data).toEqual(rec());
  });

  it(`${name}: put is an idempotent upsert on reviewId: second put wins, exactly one record`, async () => {
    await store.put(rec({ runId: 'run-v1', callId: 'call-v1', eveRequestId: 'req-v1',
      continuationToken: 'token-v1', parkedAt: '2026-07-26T10:00:00.000Z' }));
    await store.put(rec({ runId: 'run-v2', callId: 'call-v2', eveRequestId: 'req-v2',
      continuationToken: 'token-v2', parkedAt: '2026-07-26T10:00:01.000Z' }));
    const r = await store.get('conf-review');
    // Every field reflects the second put: proves a full replace, not a stale merge,
    // and that the reviewId key still maps to exactly one record.
    expect(r.data).toEqual(rec({ runId: 'run-v2', callId: 'call-v2', eveRequestId: 'req-v2',
      continuationToken: 'token-v2', parkedAt: '2026-07-26T10:00:01.000Z' }));
  });

  it(`${name}: two different reviewIds coexist independently`, async () => {
    await store.put(rec({ reviewId: 'conf-review-a', callId: 'call-a' }));
    await store.put(rec({ reviewId: 'conf-review-b', callId: 'call-b' }));
    const a = await store.get('conf-review-a');
    const b = await store.get('conf-review-b');
    expect(a.data).toEqual(rec({ reviewId: 'conf-review-a', callId: 'call-a' }));
    expect(b.data).toEqual(rec({ reviewId: 'conf-review-b', callId: 'call-b' }));
    expect((await store.get('conf-review-c')).data).toBeNull();
  });

  it(`${name}: parkedAt round-trips the exact ISO string`, async () => {
    const withMillis = rec({ reviewId: 'conf-review-ts', parkedAt: '2026-07-26T10:00:00.123Z' });
    await store.put(withMillis);
    const r = await store.get('conf-review-ts');
    expect(r.data!.parkedAt).toBe('2026-07-26T10:00:00.123Z');
  });

  it(`${name}: a store whose backend errors returns typed err, never throws, never partial`, async () => {
    const failing = await makeFailingStore();
    const putResult = await failing.put(rec());
    expect(putResult.error).not.toBeNull();
    expect(putResult.error!.type).toBeTruthy();
    expect(putResult.error!.code).toBeTruthy();

    const getResult = await failing.get('conf-review');
    expect(getResult.error).not.toBeNull();
    expect(getResult.data).toBeNull();
  });
}
