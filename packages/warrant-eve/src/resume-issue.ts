/**
 * resume-issue.ts: approved/edited branch of resumeByPoll.
 * Extracted to keep resume.ts ≤200 lines.
 */
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { issueWarrant, paramsHash } from '@idriszade/warrant-core';
import type { ActionRequest, Principal, Verdict, Warrant, WarrantError } from '@idriszade/warrant-core';
import { evaluate } from '@idriszade/warrant-policy';
import { rebindParamsForEdit } from '@idriszade/warrant-gatewerk';
import type { ReviewContent, ReviewDecision } from '@idriszade/warrant-gatewerk';
import type { WarrantEveDeps } from './deps.js';

/**
 * CONCRETE ON PURPOSE, and reviewed rather than inherited.
 *
 * The `Gate` port's content is opaque because the port reads no field of it
 * anywhere. That argument does not reach here: this module **reads** the
 * content. `isEmailContent` checks three fields by name, fail-closed, and
 * `authorized.to` becomes the signed `action.target` below, recomputed from the
 * FINAL content, so a reviewer who corrects the recipient moves the target with
 * it. `paramsHash` covers params and not target, so a target left behind would
 * be a signed authorization naming somebody the params do not.
 *
 * This is the type of the guard's OUTPUT, not a claim about an incoming value.
 * `raw` is `unknown` until `isEmailContent` narrows it. Deleting the alias would
 * relocate the domain knowledge into an unnamed inline predicate, not remove it.
 *
 * `warrant-eve` is `kernel: false` (warrant's adapter to one agent runtime),
 * and none of this is on the package's public surface (`src/index.ts` exports
 * neither this type nor `mintHumanWarrant`; `resume.ts` is the only importer).
 *
 * WHAT WOULD BEAT THIS: a second real consumer of `mintHumanWarrant`, at which point
 * the thing it will have to solve is exactly the `.to` read: the resume path
 * holds no `WarrantToolBinding`, so it cannot ask `toTarget` (`deps.ts:42`) for
 * the target the way the request path does, and `toTarget` takes the caller's
 * input anyway, not the reviewer's edit.
 */
export type EmailContent = { to: string; subject: string; body: string };

export function isEmailContent(v: unknown): v is EmailContent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['to'] === 'string' && o['to'] !== '' &&
    typeof o['subject'] === 'string' &&
    typeof o['body'] === 'string';
}

export interface MintResult { warrant: Warrant; authorized: EmailContent }

export async function mintHumanWarrant(opts: {
  deps: WarrantEveDeps;
  runId: string;
  reviewId: string;
  requestId: string;
  /**
   * The `review.submitted` content, read straight back off the ledger and NOT
   * validated by anyone yet, hence `unknown`.
   *
   * Typed `unknown` rather than `EmailContent` because a type describing a value
   * nobody has checked is a claim, not a guarantee: a run whose content row is
   * `null` arrives here as `null`
   * (pinned by `tests/mint-guards.test.ts`, the `v === null` half of the guard).
   * The shape is established at step 8b and nowhere else.
   */
  content: unknown;
  principal: Principal;
  decision: ReviewDecision;
  actionKind: string;
  originalContext: Record<string, unknown>;
}): Promise<Result<MintResult, WarrantError>> {
  const { deps, decision, content } = opts;

  // Step 8a: compute authorized params.
  //
  // `content` is unvalidated and `rebindParamsForEdit` takes a `ReviewContent`, so
  // the edited branch coerces a non-object to `{}`. **That coercion is inert on
  // every path resumeByPoll can reach, and this was measured rather than assumed:**
  // replacing `{}` with a fully-formed poison email left every test in
  // mint-guards green. `resume.ts` step 6 refuses an `edited` decision carrying no
  // `editedContent`, and `rebindParamsForEdit` REPLACES rather than merges,
  // so `originalParams` is discarded every time this branch actually runs. The
  // coercion exists to make the argument's TYPE honest, and `{}` is the
  // fail-closed value for the branch the product cannot reach: it fails the guard
  // below exactly as a missing original would.
  //
  // The approved branch passes `content` through untouched, so a null or a scalar
  // still reaches `isEmailContent` and is refused there rather than here.
  const raw: unknown = decision.decision === 'edited'
    ? rebindParamsForEdit(
        decision,
        (typeof content === 'object' && content !== null ? content : {}) as ReviewContent,
      )
    : content;

  // Step 8b: shape guard (fail-closed)
  if (!isEmailContent(raw)) {
    return err({ type: 'validation', code: 'malformed_review_content',
      message: 'authorized content is missing or has invalid required fields (to, subject, body)' });
  }
  const authorized: EmailContent = raw;

  // Step 8c: reconstruct ActionRequest with final content + original context
  const request: ActionRequest = {
    id: opts.requestId,
    runId: opts.runId,
    principal: opts.principal,
    action: { kind: opts.actionKind, target: authorized.to, params: authorized },
    context: opts.originalContext,
  };

  // Step 8d: re-run policy on the FINAL content (load-bearing security fix)
  const reEval = evaluate(request, deps.policy);
  if (reEval.path === 'deny') {
    return err({ type: 'validation', code: 'policy_denied_on_final',
      message: `Policy denied final content: ${reEval.reason}` });
  }

  // Step 8e: build verdict from re-evaluated policy
  const verdict: Verdict = {
    path: 'human',
    ruleId: reEval.ruleId,
    policyVersion: deps.policy.doc.version,
    policyHash: deps.policy.hash,
    reason: 'human_review',
  };

  // Step 8f: issue warrant
  const issued = issueWarrant(
    { request, verdict, reviewRef: opts.reviewId, ttlMs: deps.humanTtlMs },
    { keys: deps.keys, now: deps.now, newId: deps.newId },
  );
  if (issued.error) {
    return err({ type: 'validation', code: 'issue_failed', message: issued.error.message });
  }
  const w = issued.data;

  // Step 8g: defense-in-depth paramsHash cross-check
  let ph: string;
  try { ph = paramsHash(authorized); } catch {
    return err({ type: 'integrity', code: 'paramshash_mismatch', message: 'paramsHash(authorized) threw' });
  }
  if (w.action.paramsHash !== ph) {
    return err({ type: 'integrity', code: 'paramshash_mismatch', message: 'issueWarrant paramsHash diverged' });
  }

  return ok({ warrant: w, authorized });
}
