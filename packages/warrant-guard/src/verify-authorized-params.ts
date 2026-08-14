/**
 * The security core of the enforcement seam, on its own.
 *
 * Three call sites run `verify signature and expiry → confirm the run → recompute the params
 * digest → compare it to the signed one` before a side effect. Their surrounding shapes differ
 * legitimately: one returns a `Result` and spends a nonce, one throws and its authority was
 * already spent, one records a refusal outcome, so folding them into a single pipeline would
 * force one shape onto three positions. What must NOT be three copies is this: the part that
 * decides whether the presented bytes are the bytes somebody actually authorized.
 *
 * **The danger this closes is drift**, not a live hole. A fix applied to one copy and not the
 * others is how a guard quietly stops being a guard.
 *
 * Vendor-blind by construction, like everything in this package: it knows a `Warrant`, an
 * opaque params value, a key and a clock, and nothing else. `tests/vendor-blind.test.ts`
 * enforces that over this file's source, comments included.
 */

import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Warrant, WarrantError } from '@idriszade/warrant-core';
import { paramsHash, verifyWarrant } from '@idriszade/warrant-core';

export interface AuthorityCheckDeps {
  publicKeyHex: string;
  now: () => Date;
  /**
   * The runId the caller independently believes it is acting in, or null when it has none to
   * compare. Required and nullable rather than optional: "no run check" must be a written
   * decision at each call site, not a default someone forgets.
   */
  expectedRunId: string | null;
}

/**
 * Answer one question: does `warrant` authorize exactly `finalParams`, right now?
 *
 * `finalParams` is FINAL: the caller has already done whatever validation or stripping it
 * does, and these are the bytes it is about to act on. Hashing anything else would let a value
 * the caller never sees move the digest, or a value it does see stay out of it.
 *
 * The order below is locked, and each step is a precondition of the next: an unverified
 * warrant's runId and paramsHash are attacker-controlled, so comparing against them first
 * would be comparing against nothing.
 */
export function verifyAuthorizedParams(
  warrant: Warrant,
  finalParams: unknown,
  deps: AuthorityCheckDeps,
): Result<void, WarrantError> {
  // Signature and expiry. Nothing below this line means anything for a warrant that does not
  // verify, because every field it is about to be read for is only as trustworthy as this.
  const verified = verifyWarrant(warrant, deps.publicKeyHex, deps.now());
  if (verified.error) return err(verified.error);

  // runId is a signed field, and the caller reached this warrant by some lookup of its own.
  // Checking the two against each other is what stops a store that returns another run's rows
  // from smuggling authority across runs.
  if (deps.expectedRunId !== null && warrant.runId !== deps.expectedRunId) {
    return err<WarrantError>({
      type: 'integrity',
      code: 'run_mismatch',
      message: `warrant run mismatch: warrant bound ${warrant.runId}, caller is acting in ${deps.expectedRunId}`,
    });
  }

  // GhostApproval defence. canonicalJson throws on non-plain values by design, and params are
  // caller data, so the throw is a typed refusal here rather than an exception escaping into a
  // caller that is about to decide whether an action happened.
  let computed: string;
  try {
    computed = paramsHash(finalParams);
  } catch (e) {
    return err<WarrantError>({
      type: 'integrity',
      code: 'params_noncanonical',
      message: `paramsHash computation failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (computed !== warrant.action.paramsHash) {
    return err<WarrantError>({
      type: 'integrity',
      code: 'params_mismatch',
      message: `params hash mismatch: warrant bound ${warrant.action.paramsHash}, got ${computed}`,
    });
  }

  return ok(undefined);
}
