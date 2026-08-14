import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { GENESIS_PREV_HASH, entryHash, reviewIdOf, reviewRefOf } from './entry.js';
import type { LedgerAppendInput, LedgerEntry, Ledger } from './entry.js';

function getNonce(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'nonce' in payload) {
    const n = (payload as Record<string, unknown>)['nonce'];
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

export class MemoryLedger implements Ledger {
  private _entries: LedgerEntry[] = [];

  async append(input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> {
    if (input.event === 'action.executed') {
      const nonce = getNonce(input.payload);
      if (nonce !== undefined && this._entries.some(e => e.event === 'action.executed' && getNonce(e.payload) === nonce)) {
        return err({ type: 'integrity', code: 'nonce_spent', message: `Nonce already spent: ${nonce}` });
      }
    }
    // Claim uniqueness (master C5): (event, reviewId) and (event, reviewRef) are each
    // independent unique dimensions, mirroring the two Postgres partial unique indexes.
    // Check-then-push with no intervening await: this is the TOCTOU close for the in-memory
    // backend. Placed after the nonce check so a nonce collision on the same entry wins
    // (nonce_spent), never masked by a coincidental reviewId/reviewRef match.
    const claimReviewId = reviewIdOf(input.payload);
    if (claimReviewId !== undefined &&
        this._entries.some(e => e.event === input.event && reviewIdOf(e.payload) === claimReviewId)) {
      return err({ type: 'integrity', code: 'duplicate_review_claim',
        message: `Review already claimed for event ${input.event}: ${claimReviewId}` });
    }
    const claimReviewRef = reviewRefOf(input.payload);
    if (claimReviewRef !== undefined &&
        this._entries.some(e => e.event === input.event && reviewRefOf(e.payload) === claimReviewRef)) {
      return err({ type: 'integrity', code: 'duplicate_review_claim',
        message: `Review already claimed for event ${input.event}: ${claimReviewRef}` });
    }
    const prev = this._entries.at(-1);
    const seq = prev ? prev.seq + 1 : 1;
    const prevHash = prev ? prev.hash : GENESIS_PREV_HASH;
    // input spreads FIRST: the ledger owns seq and prevHash, and a caller that hands
    // them in (by spreading an entry read from elsewhere, or from untyped JS where
    // LedgerAppendInput's absence of those fields is not enforced) must not be able to
    // place its entry anywhere it likes. Spreading input last let the caller's values
    // win over the ones just computed above.
    const base = { ...input, seq, prevHash };
    // Fix #2: wrap entryHash (which calls canonicalJson) in try/catch, since non-plain payloads throw
    let hash: string;
    try {
      hash = entryHash(base);
    } catch (e) {
      return err({ type: 'integrity', code: 'noncanonical_payload', message: String(e) });
    }
    const entry: LedgerEntry = { ...base, hash };
    this._entries.push(entry);
    return ok(structuredClone(entry));
  }

  async readRun(runId: string): Promise<Result<LedgerEntry[], WarrantError>> {
    // Fix #3: deep-copy entries to prevent caller mutation of internal state
    return ok(structuredClone(this._entries.filter(e => e.runId === runId)));
  }

  async readAll(): Promise<Result<LedgerEntry[], WarrantError>> {
    // Fix #3: deep-copy entries to prevent caller mutation of internal state
    return ok(structuredClone(this._entries));
  }

  static fromEntries(entries: LedgerEntry[]): MemoryLedger {
    const ledger = new MemoryLedger();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      // Fix #1: require contiguous 1-based seq, since gaps indicate deleted entries (deletion forgery)
      if (e.seq !== i + 1) throw new Error(`Chain broken at index ${i}: expected seq ${i + 1}, got ${e.seq}`);
      const expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i - 1]!.hash;
      if (e.prevHash !== expectedPrev) throw new Error(`Chain broken at seq ${e.seq}: prevHash mismatch`);
      const { hash, ...rest } = e;
      if (hash !== entryHash(rest)) throw new Error(`Chain broken at seq ${e.seq}: hash mismatch`);
      ledger._entries.push(structuredClone(e));
    }
    return ledger;
  }
}
