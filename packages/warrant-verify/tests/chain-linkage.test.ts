// verifyChain's prevHash-linkage check had NO coverage anywhere in the repo.
//
// Measured, not assumed: deleting the `e.prevHash !== expectedPrev` half of the
// guard left all 478 tests across all nine warrant packages green. Every existing
// tamper test mutates a payload and leaves the hash stale, which the OTHER half of
// the guard (`e.hash !== recomputed`) catches. Nothing exercised the linkage.
//
// That gap matters because entryHash includes prevHash in its own input. An attacker
// who re-hashes after tampering produces entries that are each internally
// self-consistent; only the linkage to the previous entry's hash exposes them. That
// is the splice attack, and it is the specific thing a hash CHAIN buys you over a
// list of individually-hashed records.
import { describe, it, expect } from 'vitest';
import { GENESIS_PREV_HASH, entryHash } from '@idriszade/warrant-ledger';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { verifyChain } from '../src/chain.js';

const P = { kind: 'agent' as const, id: 'a' };

function entry(seq: number, prevHash: string, payload: unknown, runId = 'run-1'): LedgerEntry {
  const b = { seq, prevHash, runId, at: `2026-07-27T00:0${seq}:00Z`, event: 'warrant.requested' as const, principal: P, payload };
  return { ...b, hash: entryHash(b) };
}

function chainOf(n: number): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 1; i <= n; i++) {
    const e = entry(i, prev, { requestId: `r${i}`, actionKind: 'send_email', target: `u${i}@acme.com` });
    out.push(e);
    prev = e.hash;
  }
  return out;
}

describe('verifyChain enforces prevHash linkage, not just per-entry hashes', () => {
  it('accepts a well-formed chain', () => {
    // The positive case. Without it, a guard that rejected everything would satisfy
    // every negative assertion below.
    expect(verifyChain(chainOf(4)).error).toBeNull();
  });

  it('rejects a re-hashed entry whose link is wrong (the splice attack)', () => {
    // THE test the suite was missing. Tamper the payload AND recompute the hash, so
    // the entry is internally consistent, but point prevHash at the wrong entry.
    // The per-entry hash check passes; only the linkage check catches this.
    const c = chainOf(4);
    const forged = { seq: 3, prevHash: c[0]!.hash, runId: 'run-1', at: c[2]!.at,
      event: 'warrant.requested' as const, principal: P,
      payload: { requestId: 'r3', actionKind: 'send_email', target: 'attacker@evil.example' } };
    c[2] = { ...forged, hash: entryHash(forged) };

    // Prove the forgery really is self-consistent, so the test cannot pass via the
    // hash check by accident.
    const { hash, ...rest } = c[2]!;
    expect(hash).toBe(entryHash(rest));

    const r = verifyChain(c);
    expect(r.error?.code).toBe('chain_broken');
    expect(r.error?.message).toMatch(/seq 3/);
  });

  it('rejects a chain whose first entry does not link to GENESIS', () => {
    const c = chainOf(3);
    const forged = { ...c[0]!, prevHash: 'f'.repeat(64) };
    const { hash: _h, ...rest } = forged;
    c[0] = { ...forged, hash: entryHash(rest) };
    expect(verifyChain(c).error?.code).toBe('chain_broken');
  });

  it('rejects a dropped middle entry even after the survivors are re-hashed', () => {
    // Deletion forgery: remove entry 2, renumber, and re-hash so every survivor is
    // self-consistent. Only the linkage to the removed entry's hash exposes it.
    const c = chainOf(4);
    const kept = [c[0]!, c[2]!, c[3]!];
    const renumbered: LedgerEntry[] = [];
    let prev = GENESIS_PREV_HASH;
    for (let i = 0; i < kept.length; i++) {
      // Renumber seq to stay contiguous so the seq check cannot be what catches it,
      // but keep each entry's ORIGINAL prevHash so the link is genuinely broken.
      const b = { ...kept[i]!, seq: i + 1 };
      const { hash: _h, ...rest } = b;
      renumbered.push({ ...b, hash: entryHash(rest) });
      prev = b.hash;
    }
    void prev;
    const r = verifyChain(renumbered);
    expect(r.error?.code).toBe('chain_broken');
  });

  it('rejects reordered entries', () => {
    const c = chainOf(3);
    const swapped = [c[0]!, c[2]!, c[1]!];
    expect(verifyChain(swapped).error?.code).toBe('chain_broken');
  });
});
