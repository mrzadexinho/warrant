import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import { verifyChain } from '../src/chain.js';

const PRINCIPAL = { kind: 'agent' as const, id: 'test-agent' };

function makeEntry(seq: number, prevHash: string, payload: unknown = {}): LedgerEntry {
  const base = { seq, prevHash, runId: 'run-1', at: '2026-07-16T00:00:00Z',
    event: 'warrant.requested' as const, principal: PRINCIPAL, payload };
  return { ...base, hash: entryHash(base) };
}

describe('verifyChain', () => {
  it('returns ok for empty chain', () => {
    const r = verifyChain([]);
    expect(r.error).toBeNull();
    expect(r.data).toBe(true);
  });

  it('verifies a valid single-entry chain', () => {
    const e = makeEntry(1, GENESIS_PREV_HASH);
    expect(verifyChain([e]).error).toBeNull();
  });

  it('verifies a valid multi-entry chain', () => {
    const e1 = makeEntry(1, GENESIS_PREV_HASH, { step: 1 });
    const e2 = makeEntry(2, e1.hash, { step: 2 });
    const e3 = makeEntry(3, e2.hash, { step: 3 });
    expect(verifyChain([e1, e2, e3]).error).toBeNull();
  });

  it('fails with chain_broken + seq in message when first prevHash is wrong', () => {
    const e = makeEntry(1, GENESIS_PREV_HASH);
    // mutate prevHash post-hash: recomputed hash will not match stored hash
    const r = verifyChain([{ ...e, prevHash: 'b'.repeat(64) }]);
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('chain_broken');
    expect(r.error?.message).toMatch(/seq 1/);
  });

  it('fails when a single char in a stored hash is flipped', () => {
    const e1 = makeEntry(1, GENESIS_PREV_HASH);
    const e2 = makeEntry(2, e1.hash);
    const last = e1.hash[e1.hash.length - 1]!;
    const flipped = { ...e1, hash: e1.hash.slice(0, -1) + (last === 'a' ? 'b' : 'a') };
    expect(verifyChain([flipped, e2]).error?.code).toBe('chain_broken');
  });

  it('fails when two entries are swapped', () => {
    const e1 = makeEntry(1, GENESIS_PREV_HASH, { n: 1 });
    const e2 = makeEntry(2, e1.hash, { n: 2 });
    expect(verifyChain([e2, e1]).error?.code).toBe('chain_broken');
  });

  it('rejects gapped chain [seq1, seq2, seq4]: deletion forgery', () => {
    const e1 = makeEntry(1, GENESIS_PREV_HASH, { n: 1 });
    const e2 = makeEntry(2, e1.hash, { n: 2 });
    const e3 = makeEntry(3, e2.hash, { n: 3 });
    // Deletion forgery: drop e3, re-link seq4 to e2's hash with recomputed hash
    const e4gap = makeEntry(4, e2.hash, { n: 4 });
    // Valid 3-entry chain verifies
    expect(verifyChain([e1, e2, e3]).error).toBeNull();
    // Gapped chain [1,2,4] must fail contiguity
    const r = verifyChain([e1, e2, e4gap]);
    expect(r.error?.code).toBe('chain_broken');
    expect(r.error?.message).toMatch(/contiguity/);
  });
});
