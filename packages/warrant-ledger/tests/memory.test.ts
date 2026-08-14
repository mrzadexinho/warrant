import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '../src/memory.js';
import { GENESIS_PREV_HASH, entryHash } from '../src/entry.js';
import type { LedgerAppendInput } from '../src/entry.js';

const inp = (o: Partial<LedgerAppendInput> = {}): LedgerAppendInput => ({
  runId: 'run-1', at: '2026-07-16T00:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'a1' }, payload: {}, ...o,
});

describe('MemoryLedger.append', () => {
  it('seq=1, prevHash=GENESIS for first entry', async () => {
    const l = new MemoryLedger();
    const r = await l.append(inp());
    expect(r.data!.seq).toBe(1);
    expect(r.data!.prevHash).toBe(GENESIS_PREV_HASH);
  });
  it('seq=2, prevHash=first.hash for second entry', async () => {
    const l = new MemoryLedger();
    const r1 = await l.append(inp());
    const r2 = await l.append(inp({ at: '2026-07-16T00:00:01.000Z' }));
    expect(r2.data!.seq).toBe(2);
    expect(r2.data!.prevHash).toBe(r1.data!.hash);
  });
  it('stored hash matches recomputed entryHash', async () => {
    const l = new MemoryLedger();
    const { hash, ...rest } = (await l.append(inp())).data!;
    expect(hash).toBe(entryHash(rest));
  });
});

describe('MemoryLedger nonce spent-check', () => {
  it('first action.executed with nonce succeeds', async () => {
    const l = new MemoryLedger();
    const r = await l.append(inp({ event: 'action.executed', payload: { warrantId: 'w1', nonce: 'n1' } }));
    expect(r.error).toBeNull();
  });
  it('second action.executed with same nonce → nonce_spent', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ event: 'action.executed', payload: { warrantId: 'w1', nonce: 'n1' } }));
    const r = await l.append(inp({ event: 'action.executed', at: '2026-07-16T00:01:00.000Z', payload: { warrantId: 'w2', nonce: 'n1' } }));
    expect(r.error!.type).toBe('integrity');
    expect(r.error!.code).toBe('nonce_spent');
  });
  it('non-action.executed events skip nonce check', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ event: 'warrant.issued', payload: { nonce: 'n-dup' } }));
    const r = await l.append(inp({ event: 'warrant.issued', at: '2026-07-16T00:01:00.000Z', payload: { nonce: 'n-dup' } }));
    expect(r.error).toBeNull();
  });
});

describe('MemoryLedger review-claim uniqueness', () => {
  it('second review.decided with the same reviewId → duplicate_review_claim', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ event: 'review.decided', payload: { requestId: 'r1', reviewId: 'rev-x', decision: 'approved', decidedBy: 'human:a' } }));
    const r = await l.append(inp({ event: 'review.decided', at: '2026-07-16T00:01:00.000Z', payload: { requestId: 'r2', reviewId: 'rev-x', decision: 'approved', decidedBy: 'human:b' } }));
    expect(r.error!.code).toBe('duplicate_review_claim');
  });
  it('second warrant.issued with the same reviewRef → duplicate_review_claim', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ event: 'warrant.issued', payload: { requestId: 'r1', warrantId: 'w1', reviewRef: 'rev-y' } }));
    const r = await l.append(inp({ event: 'warrant.issued', at: '2026-07-16T00:01:00.000Z', payload: { requestId: 'r2', warrantId: 'w2', reviewRef: 'rev-y' } }));
    expect(r.error!.code).toBe('duplicate_review_claim');
  });
  it('warrant.issued on the auto path (no reviewId, no reviewRef) is never constrained', async () => {
    const l = new MemoryLedger();
    const r1 = await l.append(inp({ event: 'warrant.issued', payload: { requestId: 'a1', warrantId: 'w1' } }));
    const r2 = await l.append(inp({ event: 'warrant.issued', at: '2026-07-16T00:01:00.000Z', payload: { requestId: 'a2', warrantId: 'w2' } }));
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
  });
});

describe('MemoryLedger.readRun + readAll', () => {
  it('readRun filters by runId', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ runId: 'r-a' }));
    await l.append(inp({ runId: 'r-b', at: '2026-07-16T00:00:01.000Z' }));
    await l.append(inp({ runId: 'r-a', at: '2026-07-16T00:00:02.000Z' }));
    const r = await l.readRun('r-a');
    expect(r.data!).toHaveLength(2);
    expect(r.data!.every(e => e.runId === 'r-a')).toBe(true);
  });
  it('readAll returns entries in seq order', async () => {
    const l = new MemoryLedger();
    await l.append(inp()); await l.append(inp({ at: '2026-07-16T00:00:01.000Z' }));
    expect((await l.readAll()).data!.map(e => e.seq)).toEqual([1, 2]);
  });
});

describe('MemoryLedger.fromEntries', () => {
  it('rebuilds valid chain', async () => {
    const l = new MemoryLedger();
    await l.append(inp()); await l.append(inp({ at: '2026-07-16T00:00:01.000Z' }));
    const all = (await l.readAll()).data!;
    const r2 = await MemoryLedger.fromEntries(all).readAll();
    expect(r2.data!).toHaveLength(2);
  });
  it('throws on broken prevHash', async () => {
    const l = new MemoryLedger();
    await l.append(inp());
    const all = (await l.readAll()).data!;
    expect(() => MemoryLedger.fromEntries([{ ...all[0]!, prevHash: 'b'.repeat(64) }])).toThrow(/Chain broken/);
  });
  it('throws on tampered payload (hash mismatch)', async () => {
    const l = new MemoryLedger();
    await l.append(inp());
    const all = (await l.readAll()).data!;
    expect(() => MemoryLedger.fromEntries([{ ...all[0]!, payload: { tampered: true } }])).toThrow(/Chain broken/);
  });
});
