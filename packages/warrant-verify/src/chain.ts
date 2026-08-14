import type { Result } from '@idriszade/core';
import { err, ok } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';

/**
 * Recomputes every entryHash + prevHash linkage from GENESIS.
 * Never throws: any canonicalJson/entryHash failure on a malformed entry becomes chain_broken.
 */
export function verifyChain(entries: LedgerEntry[]): Result<true, WarrantError> {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const expectedSeq = i + 1;
    if (e.seq !== expectedSeq) {
      return err({ type: 'integrity', code: 'chain_broken',
        message: `seq contiguity broken at index ${i}: expected ${expectedSeq}, got ${e.seq}` });
    }
    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i - 1]!.hash;
    let recomputed: string;
    try {
      recomputed = entryHash({
        seq: e.seq, prevHash: e.prevHash, runId: e.runId,
        at: e.at, event: e.event, principal: e.principal, payload: e.payload,
      });
    } catch {
      return err({ type: 'integrity', code: 'chain_broken',
        message: `Chain integrity failure at seq ${e.seq}: cannot canonicalize entry` });
    }
    if (e.prevHash !== expectedPrev || e.hash !== recomputed) {
      return err({ type: 'integrity', code: 'chain_broken',
        message: `Chain integrity failure at seq ${e.seq}` });
    }
  }
  return ok(true);
}
