// drainer.ts: the §8 governed drainer. `execute` never calls an MTA directly (a crash between
// the SMTP handoff and the ledger write would make the proof and reality disagree): it enqueues
// to the outbox and this drainer sends.
//
// The drainer re-does `execute`'s verification INDEPENDENTLY. It trusts the outbox row for
// exactly two things, its requestId and its runId, which are only lookup keys; everything that
// authorizes the send is re-read from the ledger and re-checked here. A drainer that trusted
// the queue row would be an ungoverned path to a side effect, which renders every warrant
// upstream decorative, and that is the defect §8 exists to prevent.
//
// The 8-step order below is LOCKED (plan contract P3) and none of it may be reordered. Step 7
// is "never silently retry a spent nonce"; `queued`, which `execute` writes for every
// legitimate row, is NOT terminal. Step 0's lock is the honest close on multi-instance
// drainers: within one instance the row loop is sequential, but ACROSS instances only the lock
// stops a second process interleaving between step 7 and step 8. The ledger does not prevent a
// double send on its own.
//
// It imports from @idriszade/core, warrant-core, warrant-ledger, warrant-guard and ./outbox.js
// only. It lives in warrant-eve because that is where §8 places it, not because it needs eve.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Principal, Warrant, WarrantError } from '@idriszade/warrant-core';
import { verifyAuthorizedParams } from '@idriszade/warrant-guard';
import type { Ledger, LedgerEntry } from '@idriszade/warrant-ledger';
import type { DrainerLock, Outbox, OutboxRow, Sender } from './outbox.js';

export interface DrainerDeps {
  ledger: Ledger;
  publicKeyHex: string;
  now: () => Date;
  principal: Principal;
}

export type DrainResult =
  | { requestId: string; status: 'sent'; messageId: string }
  | { requestId: string; status: 'failed'; code: string }
  | { requestId: string; status: 'skipped'; code: string };

function payloadOf(e: LedgerEntry): Record<string, unknown> {
  return (typeof e.payload === 'object' && e.payload !== null)
    ? e.payload as Record<string, unknown>
    : {};
}

function forRequest(entries: LedgerEntry[], event: LedgerEntry['event'], requestId: string): LedgerEntry[] {
  return entries.filter(e => e.event === event && payloadOf(e)['requestId'] === requestId);
}

// Returns false when the outcome could not be recorded. Wrapped because a Ledger is an
// interface a third party implements: `append` is contracted to return a Result, and a
// throwing implementation must not take the rest of the drain down with it.
async function appendOutcome(
  deps: DrainerDeps, row: OutboxRow, warrantId: unknown, extra: Record<string, unknown>,
): Promise<boolean> {
  try {
    const appended = await deps.ledger.append({
      runId: row.runId,
      at: deps.now().toISOString(),
      event: 'action.outcome',
      principal: deps.principal,
      payload: { requestId: row.requestId, warrantId, ...extra },
    });
    return !appended.error;
  } catch {
    return false;
  }
}

async function drainRow<P>(deps: DrainerDeps, row: OutboxRow, sender: Sender<P>): Promise<DrainResult> {
  const requestId = row.requestId;

  // Step 1: read the run. A read failure is a skip, never a send: unread is not unauthorized.
  const read = await deps.ledger.readRun(row.runId);
  if (read.error) return { requestId, status: 'skipped', code: 'ledger_read_error' };
  const entries = read.data;

  // Step 2: exactly one warrant.issued, or refuse. Zero means nothing authorized this row;
  // two means the ledger cannot say which warrant did, and picking one would be a guess.
  // No ledger write on this branch: there is no warrantId to attach an outcome to.
  const issued = forRequest(entries, 'warrant.issued', requestId);
  if (issued.length !== 1) return { requestId, status: 'skipped', code: 'warrant_missing' };
  const issuedPayload = payloadOf(issued[0]!);
  const w = issuedPayload['warrant'] as Warrant;
  const warrantId = issuedPayload['warrantId'];

  const refuse = async (code: string): Promise<DrainResult> => {
    await appendOutcome(deps, row, warrantId, { status: 'failed', error: code });
    return { requestId, status: 'failed', code };
  };

  // Steps 3, 4 and 5, in that locked order, are one call to the shared primitive in
  // @idriszade/warrant-guard. They are not three checks that happen to sit together: they are
  // the security core this drainer shares with the two other paths to a side effect, and the
  // reason it is imported rather than written here is that a fix applied to one copy and not
  // the others is how a guard quietly stops being a guard.
  //
  //   Step 3: signature and expiry, against the drainer's own clock and public key.
  //   Step 4: runId is a signed field. Checked explicitly even though readRun filtered by it,
  //           so a ledger that returns another run's entries cannot smuggle a warrant across
  //           runs. That is what expectedRunId carries.
  //   Step 5: THE point of §8. The bytes about to be handed to the sender are hashed and
  //           compared to the signed hash. The digest feeds caller data through canonicalJson,
  //           which THROWS on non-plain values, so that is a typed refusal, not an exception.
  //
  // Every branch refuses rather than skipping: unlike step 1's read failure, a warrant is in
  // hand here, so there is a warrantId to attach a failed outcome to and the spent nonce must
  // never be left looking retryable.
  const authority = verifyAuthorizedParams(w, row.params, {
    publicKeyHex: deps.publicKeyHex,
    now: deps.now,
    expectedRunId: row.runId,
  });
  if (authority.error) {
    const { code } = authority.error;
    if (code === 'run_mismatch') return refuse('warrant_run_mismatch');
    if (code === 'params_noncanonical' || code === 'params_mismatch') return refuse(code);
    return refuse('warrant_' + code);
  }

  // Step 6: the nonce was spent by `execute`, and by THIS warrant. A row with no
  // action.executed never went through execute at all.
  // EVERY action.executed for this requestId, not just the first. Reading [0] made the answer
  // depend on ledger ordering: a run holding two entries, one naming this warrant and one naming
  // another, resolved on whichever happened to be first.
  const executed = forRequest(entries, 'action.executed', requestId);
  if (executed.length === 0) return refuse('not_executed');
  if (executed.some(e => payloadOf(e)['warrantId'] !== w.id)) return refuse('executed_warrant_mismatch');

  // Step 7: never silently retry a spent nonce. `queued` (written by execute) is not terminal.
  const terminal = forRequest(entries, 'action.outcome', requestId).some(e => {
    const status = payloadOf(e)['status'];
    return status === 'sent' || status === 'failed';
  });
  if (terminal) return { requestId, status: 'skipped', code: 'already_terminal' };

  // Step 8: send the exact object that was hashed, unmodified and untransformed.
  let sent: Result<{ messageId: string }, WarrantError>;
  try {
    sent = await sender.send(row.params as P);
  } catch {
    return refuse('send_threw');
  }
  if (sent.error) return refuse('send_' + sent.error.code);

  const recorded = await appendOutcome(deps, row, warrantId, {
    status: 'sent', messageId: sent.data.messageId,
  });
  // The send DID happen. It is still reported as failed, because the ledger is the only
  // authority on whether an action was sent and it holds no record of this one. The code
  // names exactly that state so an operator can tell it from a send that never left.
  if (!recorded) return { requestId, status: 'failed', code: 'outcome_append_error' };
  return { requestId, status: 'sent', messageId: sent.data.messageId };
}

// Codes that mean the row was handled but the LEDGER HOLDS NO TERMINAL RECORD of it. Retiring one
// would delete the only remaining trace, so these rows stay:
//   outcome_append_error  the send happened and the outcome append did not. This is the residual
//                         window §8's send-then-record ordering leaves open; the row stays so the
//                         state is visible, and step 7 cannot suppress a re-send because there is
//                         nothing terminal to find. Documented in the ceremony README, not closed.
//   drainer_internal_error  something threw. Usually transient, so retrying is what we want.
const NOT_RECORDED = new Set(['outcome_append_error', 'drainer_internal_error']);

/**
 * True when the ledger now carries this row's terminal outcome, so dropping the row loses nothing.
 * Retiring is a work-list operation and states nothing about the send: the ledger already did.
 */
function isLedgerRecorded(r: DrainResult): boolean {
  if (r.status === 'sent') return true;
  if (r.status === 'failed') return !NOT_RECORDED.has(r.code);
  return r.status === 'skipped' && r.code === 'already_terminal';
}

export async function drainOutbox<P>(
  deps: DrainerDeps,
  opts: { outbox: Outbox; sender: Sender<P>; limit?: number; lock?: DrainerLock },
): Promise<Result<DrainResult[], WarrantError>> {
  const lock = opts.lock;
  let acquired = false;
  if (lock) {
    try {
      acquired = await lock.acquire();
    } catch (e) {
      return err({ type: 'transient', code: 'drainer_lock_error',
        message: e instanceof Error ? e.message : 'drainOutbox: lock.acquire threw' });
    }
    // Another drainer holds it. Doing nothing is the correct outcome, not an error.
    if (!acquired) return ok([]);
  }
  try {
    const pending = await opts.outbox.listPending(opts.limit);
    if (pending.error) return err(pending.error);
    const results: DrainResult[] = [];
    // Sequential on purpose: step 7 reads the ledger state that step 8 is about to change.
    for (const row of pending.data) {
      // Per row, not per batch. A throw on row 5 used to discard the DrainResult for rows 1-4,
      // including rows that had REALLY SENT, and hand the operator a bare drainer_internal_error
      // with data:null. An operator who cannot see that an email left is worse off than one
      // holding a partial list.
      let result: DrainResult;
      try {
        result = await drainRow(deps, row, opts.sender);
      } catch {
        result = { requestId: row.requestId, status: 'failed', code: 'drainer_internal_error' };
      }
      if (isLedgerRecorded(result)) {
        // Best effort: a failed retire leaves the row and step 7 skips it again next pass.
        await opts.outbox.retire(row.requestId).catch(() => undefined);
      }
      results.push(result);
    }
    return ok(results);
  } catch (e) {
    return err({ type: 'transient', code: 'drainer_internal_error',
      message: e instanceof Error ? e.message : 'drainOutbox: unexpected error' });
  } finally {
    // `lock &&` is type narrowing, not a second condition: `acquired` can only be true when
    // a lock exists. Release is never called for a lock that was never acquired.
    if (acquired && lock) {
      try { await lock.release(); } catch { /* release is contracted never to throw */ }
    }
  }
}
