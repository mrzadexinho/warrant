// Outbox (§8, contract P1): the governed work list that sits between `execute` and the MTA.
// `execute` enqueues; a separate drainer (drainer.ts) sends. That split exists because a crash
// between the SMTP handoff and the ledger write would make the proof and reality disagree.
//
// The outbox is a WORK LIST, NOT A STATE MACHINE. It deliberately carries no `sent` column:
// the ledger is the only authority on whether an action was sent (§8 step 4), exactly as the
// park store holds no authorization data (§3.3). A second mutable source of truth for "did this
// send" is the thing the certificate would then have to reconcile against.
//
// `retire` is how that stays true AND the list stays finite. It removes a row that has reached a
// terminal state IN THE LEDGER; it records nothing and asserts nothing, so the ledger is still the
// only place that says whether an action sent. Without it the design deadlocks: rows are never
// removed, listPending is LIMIT-ed and ordered oldest-first, so after DEFAULT_OUTBOX_LIMIT terminal
// rows accumulate the drainer returns the same 100 already_terminal skips forever and every newer
// row is unreachable. That was measured on the first cut of this file, not theorised. Retiring is
// best-effort: a failed retire leaves the row, and step 7 skips it again next pass.
//
// Also here: `Sender<P>` (the MTA seam) and `DrainerLock` (single-drainer enforcement).
import { ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

export interface OutboxRow {
  requestId: string;   // == ctx.callId == the warrant.issued payload's requestId
  runId: string;
  params: unknown;     // THE EXACT object hashed into warrant.action.paramsHash
  enqueuedAt: string;  // ISO
}

export interface Outbox {
  enqueue(row: OutboxRow): Promise<Result<void, WarrantError>>;  // idempotent on requestId
  listPending(limit?: number): Promise<Result<OutboxRow[], WarrantError>>;  // oldest first
  /** Drop a row whose fate the LEDGER already records. Absent row is not an error. */
  retire(requestId: string): Promise<Result<void, WarrantError>>;
}

/**
 * Receives THE SAME OBJECT the drainer hashed, unmodified and untransformed. Any narrowing,
 * validation or templating belongs inside the implementation, AFTER the hash check. That is
 * the literal content of §8 step 3: the bytes handed to SMTP are the bytes that were hashed.
 */
export interface Sender<P> {
  send(params: P): Promise<Result<{ messageId: string }, WarrantError>>;
}

/** Single-drainer enforcement: a second process must not interleave between §8 steps 7 and 8. */
export interface DrainerLock {
  acquire(): Promise<boolean>;  // false when already held; never throws
  release(): Promise<void>;     // never throws
}

/** Default page size for listPending when the caller names none. */
export const DEFAULT_OUTBOX_LIMIT = 100;

export class MemoryOutbox implements Outbox {
  private readonly rows = new Map<string, OutboxRow>();

  // First write wins. The warrant upstream was minted over the params of the FIRST enqueue;
  // letting a re-enqueue swap them under an already-issued warrant would turn a benign retry
  // into a permanent params_mismatch at drain time.
  async enqueue(row: OutboxRow): Promise<Result<void, WarrantError>> {
    if (this.rows.has(row.requestId)) return ok(undefined);
    // Shallow copy only: `params` is stored BY REFERENCE on purpose. park-store.ts structuredClones
    // its records, and doing that here would silently REWRITE the thing §8 step 3 is about, because
    // structuredClone drops functions and symbols with a DataCloneError and does not preserve
    // prototypes. The store must not be able to change what gets hashed; keeping the reference
    // leaves that question where §8 puts it, at the drainer's paramsHash comparison.
    this.rows.set(row.requestId, { ...row });
    return ok(undefined);
  }

  async retire(requestId: string): Promise<Result<void, WarrantError>> {
    this.rows.delete(requestId);
    return ok(undefined);
  }

  async listPending(limit?: number): Promise<Result<OutboxRow[], WarrantError>> {
    const sorted = [...this.rows.values()]
      .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0))
      .slice(0, limit ?? DEFAULT_OUTBOX_LIMIT)
      .map(r => ({ ...r }));
    return ok(sorted);
  }
}
