/**
 * The enforcement seam. **One guard, many actuators.**
 *
 * Every path to a side effect runs this sequence, in this order:
 *
 *   parse → verifyWarrant → recompute paramsHash → compare → spend nonce → act → record
 *
 * The middle three are `verifyAuthorizedParams`, shared with the two call sites whose
 * surrounding shape is not this one. Parsing comes first here because that check hashes FINAL
 * params and stripping is what makes them final.
 *
 * A duplicate actuator is a Tuesday. A duplicate guard is a vulnerability, which is why this
 * lives in its own package: the dependency graph, not discipline, is what keeps it single.
 *
 * **The actuator owns its schema and its effect closure. This function owns everything
 * between them,** and knows nothing about what the effect does or who it talks to. If it ever
 * needs to, the abstraction has failed.
 *
 * That is enforced, not requested: `tests/vendor-blind.test.ts` pins the dependency set exactly
 * and fails on any vendor, transport or domain word appearing anywhere in this directory,
 * including in a comment. It caught this very paragraph naming two vendors as examples, which
 * was the right catch: listing examples implies a known set, and the claim is that the set is
 * unknowable from here.
 */

import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Warrant, WarrantError } from '@idriszade/warrant-core';
import type { Ledger } from '@idriszade/warrant-ledger';
import type { ZodType } from 'zod';
import { verifyAuthorizedParams } from './verify-authorized-params.js';

export interface GuardDeps {
  publicKeyHex: string;
  ledger: Ledger;
  now: () => Date;
  /**
   * The actuator's own word for a successful execution: `'queued'`, `'sent'`, `'opened'`.
   * A per-actuator constant, which is why it sits in deps. The guard supplies `'failed'`
   * itself, because failure is not a vendor concept.
   *
   * Deliberately NOT a free payload: the guard's ledger writes stay uniform so replay can
   * correlate them without knowing which actuator produced them.
   */
  outcomeStatus: string;
}

/**
 * Run `effect` if and only if `warrant` authorizes exactly these params.
 *
 * **The nonce is spent before the effect runs.** If the effect fails, the nonce is burned and
 * the warrant cannot be retried. That is fail-closed on purpose: a burned nonce with no side
 * effect is strictly safer than a reusable warrant retried into a double-send. The failure is
 * recorded in `action.outcome` so the burn is never a silent gap.
 */
export async function guardedExecute<T, R>(
  warrant: Warrant,
  rawParams: unknown,
  schema: ZodType<T>,
  deps: GuardDeps,
  effect: (params: T) => Promise<Result<R, WarrantError>>,
): Promise<Result<R, WarrantError>> {
  // Validate and strip at the boundary. safeParse rather than parse: a schema throw is a
  // refusal, not an exception, and the guard must never propagate one to a caller that is
  // about to decide whether a side effect happened.
  //
  // This runs BEFORE the authority check because the check hashes FINAL params, and stripping
  // is what makes them final. Hashing the raw input instead would let an extra key move the
  // digest while the effect never sees it.
  const parsed = schema.safeParse(rawParams);
  if (!parsed.success) {
    return err<WarrantError>({
      type: 'validation',
      code: 'invalid_params',
      message: `params failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    });
  }

  // Signature, expiry, and the GhostApproval compare. Nothing below this line runs for a
  // warrant that does not verify or does not bind exactly these bytes. What a human approved
  // and what executes must be provably the same bytes.
  const authority = verifyAuthorizedParams(warrant, parsed.data, {
    publicKeyHex: deps.publicKeyHex,
    now: deps.now,
    // No independent run to compare against: this function appends under warrant.runId, so
    // there is no second source of truth for the run and nothing to cross-check it with.
    expectedRunId: null,
  });
  if (authority.error) {
    // `params_noncanonical` and `params_mismatch` are never rewritten into each other:
    // **the two are different facts and only one of them is an alarm.**
    //
    // `params_mismatch` means the bytes canonicalised fine and hashed to something other than
    // what was signed: somebody changed the payload after it was authorized, which is the
    // single most alarming thing this system reports. `params_noncanonical` means the bytes
    // could not be canonicalised at all: a structural fault in the caller's own params, with
    // no adversary implied. Collapsing them dilutes every genuine mismatch with a class of
    // fault that is not one, on the guard's public surface, in a system whose adapters surface
    // the code as text to a reader deciding what to tell a person.
    //
    // Every other caller of `verifyAuthorizedParams` reports them distinctly: the two
    // eve sites and the drainer all branch on both.
    //
    // Fail-closed is unchanged either way: both are errors and a caller that recognises
    // neither still refuses, which is what makes widening the returned set safe.
    return err<WarrantError>(authority.error);
  }

  // Spend the nonce. `nonce` in the payload is load-bearing, not informational: Postgres
  // enforces single-spend with an in-transaction check plus a unique partial index over
  // payload->>'nonce' scoped to action.executed. The redundancy is deliberate.
  //
  // The principal comes from the warrant and is never supplied separately. Two sources for
  // "who acted" is a hole, and replay correlates on this one.
  const executed = await deps.ledger.append({
    runId: warrant.runId,
    at: deps.now().toISOString(),
    event: 'action.executed',
    principal: warrant.principal,
    payload: { warrantId: warrant.id, nonce: warrant.nonce },
  });
  // No record, no act. Acting here would be an unrecorded side effect.
  if (executed.error) return err(executed.error);

  // Authority is now consumed. Everything below records what happened with it.
  let outcome: Result<R, WarrantError>;
  try {
    outcome = await effect(parsed.data);
  } catch (e) {
    // Actuators call vendor SDKs. An unguarded throw escaping here would skip the outcome
    // append entirely and leave a spent nonce with no record: the exact gap this closes.
    outcome = err<WarrantError>({
      type: 'permanent',
      code: 'effect_threw',
      message: `effect threw rather than returning an error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const recorded = await deps.ledger.append({
    runId: warrant.runId,
    at: deps.now().toISOString(),
    event: 'action.outcome',
    principal: warrant.principal,
    payload: { warrantId: warrant.id, status: outcome.error ? 'failed' : deps.outcomeStatus },
  });

  // The effect's error wins. It is the one that says whether the side effect happened, which
  // is what the caller has to know; a bookkeeping failure on top must not mask it.
  if (outcome.error) return err(outcome.error);

  // The effect succeeded and the ledger does not fully record it. That is not success: the
  // certificate would show an execution with no outcome.
  if (recorded.error) {
    return err<WarrantError>({
      type: 'transient',
      code: 'outcome_append_failed',
      message: `action.outcome append failed after the effect succeeded: ${recorded.error.message}`,
    });
  }

  return ok(outcome.data);
}
