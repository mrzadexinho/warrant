// Shared conformance suite, imported relatively by test files ONLY.
// NOT exported from src/index.ts (vitest code must not enter the production surface).
import { describe, it, expect, beforeEach } from 'vitest';
import { GENESIS_PREV_HASH, entryHash } from '../src/entry.js';
import type { Ledger, LedgerAppendInput } from '../src/entry.js';

const base = (o: Partial<LedgerAppendInput> = {}): LedgerAppendInput => ({
  runId: 'conf-run', at: '2026-07-16T10:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'conf-agent' }, payload: { step: 'init' }, ...o,
});

export function runLedgerConformance(name: string, makeLedger: () => Promise<Ledger>): void {
  let ledger: Ledger;
  beforeEach(async () => { ledger = await makeLedger(); });

  it(`${name}: first entry links from GENESIS`, async () => {
    const r = await ledger.append(base());
    expect(r.data!.seq).toBe(1);
    expect(r.data!.prevHash).toBe(GENESIS_PREV_HASH);
  });

  it(`${name}: chain (second prevHash equals first hash)`, async () => {
    const r1 = await ledger.append(base());
    const r2 = await ledger.append(base({ at: '2026-07-16T10:00:01.000Z' }));
    expect(r2.data!.prevHash).toBe(r1.data!.hash);
    expect(r2.data!.seq).toBe(2);
  });

  it(`${name}: stored hash matches recomputed entryHash`, async () => {
    const r = await ledger.append(base());
    const { hash, ...rest } = r.data!;
    expect(hash).toBe(entryHash(rest));
  });

  it(`${name}: nonce_spent on duplicate action.executed nonce`, async () => {
    await ledger.append(base({ event: 'action.executed', payload: { warrantId: 'w1', nonce: 'conf-n' } }));
    const r2 = await ledger.append(base({
      event: 'action.executed', at: '2026-07-16T10:00:01.000Z',
      payload: { warrantId: 'w2', nonce: 'conf-n' },
    }));
    expect(r2.error!.type).toBe('integrity');
    expect(r2.error!.code).toBe('nonce_spent');
  });

  it(`${name}: readRun filters by runId`, async () => {
    await ledger.append(base({ runId: 'r-a' }));
    await ledger.append(base({ runId: 'r-b', at: '2026-07-16T10:00:01.000Z' }));
    await ledger.append(base({ runId: 'r-a', at: '2026-07-16T10:00:02.000Z' }));
    const r = await ledger.readRun('r-a');
    expect(r.data!).toHaveLength(2);
    expect(r.data!.every(e => e.runId === 'r-a')).toBe(true);
  });

  it(`${name}: persistence roundtrip (readAll in seq order with valid hashes)`, async () => {
    await ledger.append(base());
    await ledger.append(base({ at: '2026-07-16T10:00:01.000Z', payload: { step: 2 } }));
    const all = (await ledger.readAll()).data!;
    expect(all.map(e => e.seq)).toEqual([1, 2]);
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      expect(e.prevHash).toBe(i === 0 ? GENESIS_PREV_HASH : all[i - 1]!.hash);
      const { hash, ...rest } = e; expect(hash).toBe(entryHash(rest));
    }
  });

  // Claim-uniqueness conformance (master C5, the concurrent-resume TOCTOU close): held to both
  // backends. review.submitted/review.decided key on reviewId; warrant.issued and the
  // human-path warrant.denied key on reviewRef; the auto path uses neither and stays
  // unconstrained.

  it(`${name}: duplicate_review_claim on repeated (review.decided, reviewId)`, async () => {
    await ledger.append(base({ event: 'review.decided', payload: { requestId: 'req-a', reviewId: 'conf-rev', decision: 'approved', decidedBy: 'human:alice' } }));
    const r2 = await ledger.append(base({ event: 'review.decided', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-b', reviewId: 'conf-rev', decision: 'approved', decidedBy: 'human:bob' } }));
    expect(r2.error!.code).toBe('duplicate_review_claim');
  });

  it(`${name}: duplicate_review_claim on repeated (warrant.issued, reviewRef)`, async () => {
    await ledger.append(base({ event: 'warrant.issued', payload: { requestId: 'req-g1', warrantId: 'w-g1', reviewRef: 'conf-ref-g' } }));
    const r2 = await ledger.append(base({ event: 'warrant.issued', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-g2', warrantId: 'w-g2', reviewRef: 'conf-ref-g' } }));
    expect(r2.error!.code).toBe('duplicate_review_claim');
  });

  it(`${name}: review.decided for two different reviewIds both succeed`, async () => {
    const r1 = await ledger.append(base({ event: 'review.decided', payload: { requestId: 'req-f1', reviewId: 'conf-rev-f1', decision: 'approved', decidedBy: 'human:alice' } }));
    const r2 = await ledger.append(base({ event: 'review.decided', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-f2', reviewId: 'conf-rev-f2', decision: 'approved', decidedBy: 'human:bob' } }));
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
  });

  it(`${name}: review.submitted + review.decided sharing a reviewId: different events, no collision`, async () => {
    const r1 = await ledger.append(base({ event: 'review.submitted', payload: { requestId: 'req-c', reviewId: 'conf-rev2', content: {} } }));
    const r2 = await ledger.append(base({ event: 'review.decided', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-c', reviewId: 'conf-rev2', decision: 'approved', decidedBy: 'human:alice' } }));
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
  });

  it(`${name}: auto-path warrant.issued (no reviewId, no reviewRef) is never constrained`, async () => {
    const r1 = await ledger.append(base({ event: 'warrant.issued', payload: { requestId: 'req-d1', warrantId: 'w-auto-1' } }));
    const r2 = await ledger.append(base({ event: 'warrant.issued', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-d2', warrantId: 'w-auto-2' } }));
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
  });

  it(`${name}: nonce collision wins over a coincidental reviewId/reviewRef match (no cross-talk between indexes)`, async () => {
    await ledger.append(base({ event: 'action.executed', payload: { warrantId: 'w1', nonce: 'conf-n2', reviewId: 'conf-rev3', reviewRef: 'conf-ref3' } }));
    const r2 = await ledger.append(base({ event: 'action.executed', at: '2026-07-16T10:00:02.000Z', payload: { warrantId: 'w2', nonce: 'conf-n2', reviewId: 'conf-rev3', reviewRef: 'conf-ref3' } }));
    expect(r2.error!.code).toBe('nonce_spent');
  });

  // The ledger owns its own sequencing. A caller that hands in seq/prevHash (by spreading
  // an entry read from somewhere else, or from untyped JS where LedgerAppendInput's absence
  // of those fields is not enforced) must not be able to place its entry anywhere it likes.
  //
  // Found by a mutation sweep: `const base = { seq, prevHash, ...input }` spreads the input
  // LAST, so the caller's values win over the ones the ledger just computed. On
  // MemoryLedger that writes an entry with a fabricated position whose own hash covers the
  // fabrication, so it is self-consistent and only fails later, at read time, in
  // verifyChain. On PostgresLedger it is worse: the INSERT uses the computed seq and
  // prev_hash while the hash was taken over the caller's, so the persisted row's hash does
  // not match its own columns and the chain is permanently unverifiable from that point on.
  it(`${name}: a caller cannot dictate seq or prevHash`, async () => {
    await ledger.append(base());
    const smuggled = {
      ...base({ at: '2026-07-16T10:00:01.000Z', payload: { step: 2 } }),
      seq: 999,
      prevHash: 'f'.repeat(64),
    } as LedgerAppendInput;

    const r = await ledger.append(smuggled);

    expect(r.error).toBeNull();
    expect(r.data!.seq).toBe(2);
    expect(r.data!.prevHash).not.toBe('f'.repeat(64));
    // The chain the ledger actually holds must still verify end to end, which is the half
    // that catches the Postgres variant: there the columns are right and only the hash is
    // wrong, so checking the returned seq alone would report a false green.
    const all = (await ledger.readAll()).data!;
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      expect(e.prevHash).toBe(i === 0 ? GENESIS_PREV_HASH : all[i - 1]!.hash);
      const { hash, ...rest } = e;
      expect(hash).toBe(entryHash(rest));
    }
  });

  it(`${name}: a duplicate_review_claim append does not corrupt the chain and writes no partial row`, async () => {
    await ledger.append(base({ event: 'review.decided', payload: { requestId: 'req-e1', reviewId: 'conf-rev-chain', decision: 'approved', decidedBy: 'human:alice' } }));
    const before = (await ledger.readAll()).data!;
    const r2 = await ledger.append(base({ event: 'review.decided', at: '2026-07-16T10:00:01.000Z', payload: { requestId: 'req-e2', reviewId: 'conf-rev-chain', decision: 'approved', decidedBy: 'human:bob' } }));
    expect(r2.error!.code).toBe('duplicate_review_claim');
    // No partial row: readAll after the rejected append is byte-identical to readAll before it.
    const after = (await ledger.readAll()).data!;
    expect(after).toEqual(before);
    // Chain still verifies. verifyChain lives in @idriszade/warrant-verify, which depends on
    // this package, so recompute the same linkage/hash checks it performs instead of importing
    // it (would be a circular dependency).
    for (let i = 0; i < after.length; i++) {
      const e = after[i]!;
      expect(e.prevHash).toBe(i === 0 ? GENESIS_PREV_HASH : after[i - 1]!.hash);
      const { hash, ...rest } = e;
      expect(hash).toBe(entryHash(rest));
    }
  });
}
