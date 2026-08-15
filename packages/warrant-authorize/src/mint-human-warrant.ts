/**
 * The human half of the authorization seam.
 *
 * `requestAuthority` owns the request path and deliberately stops before the Gate: on the
 * human path it returns the verdict and the caller routes the review. This module is the
 * matching re-entry point for when the decision comes back. Given a human decision and the
 * provenance the caller read off the ledger, it turns the FINAL reviewed content into a
 * signed warrant, or refuses. It appends nothing: recording the decision and the outcome
 * stays with the caller, because this function must never re-record a request and must be
 * callable from a choreography it knows nothing about.
 *
 * ## Why the content narrowing is injected
 *
 * The reviewed content is domain-shaped, and this package is forbidden from knowing any
 * domain's shape (`tests/runtime-blind.test.ts` pins that against this file's own text).
 * Yet the addressee the warrant signs, `action.target`, lives INSIDE that content: a
 * reviewer who corrects the addressee must move the signed target with it, and only the
 * caller knows which field the addressee is. So the caller supplies `parseContent`, which
 * receives the final content and returns `{ target, params }` or refuses with `null`.
 * `paramsHash` covers params and not target, so a target computed from anything other than
 * the final content would be a signed authorization naming a party the params do not.
 *
 * ## The edit replaces, it never merges
 *
 * When the decision carries `editedContent`, that content IS the authorized content and the
 * original is discarded whole. Replacement is the fail-closed direction: a partial edit
 * loses the fields it omits and `parseContent` refuses the result, where a merge would
 * silently back-fill them, producing content in a combination no human ever saw as a whole.
 * This duplicates the one-line semantics of the Gate package's `rebindParamsForEdit`
 * (`warrant-gatewerk/src/rebind.ts`) with a written reason: this package's dependency set
 * excludes the Gate package by pinned test, and the semantics are load-bearing here, so a
 * shared import is not available and a silent divergence is not acceptable. The two are
 * pinned to the same behaviour by their tests.
 */

import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { ActionRequestSchema, issueWarrant, paramsHash } from '@idriszade/warrant-core';
import type {
  ActionRequest,
  KeyPair,
  Principal,
  Verdict,
  Warrant,
  WarrantError,
} from '@idriszade/warrant-core';
import { evaluate } from '@idriszade/warrant-policy';
import type { PolicyDoc } from '@idriszade/warrant-policy';

/**
 * The decision, structurally. This deliberately mirrors the Gate package's `ReviewDecision`
 * without importing it, so any Gate implementation's decision can be passed as-is while the
 * dependency set stays pinned. Every field is re-checked here rather than trusted from the
 * type: a decision arrives from outside this process, and a compile-time promise is not one
 * a JS consumer or a loose cast keeps.
 */
export interface HumanDecision {
  decision: 'approved' | 'edited' | 'rejected';
  /** The identity that decided. Required: a mint with no human named is the certificate lying. */
  decidedBy: string;
  editedContent?: Record<string, unknown>;
}

/** What the caller's narrowing produced: the addressee and the exact bytes to authorize. */
export interface AuthorizedContent<P extends Record<string, unknown>> {
  target: string;
  params: P;
}

export interface MintDeps {
  policy: { doc: PolicyDoc; hash: string };
  keys: KeyPair;
  now: () => Date;
  newId: () => string;
  humanTtlMs: number;
}

export interface HumanMintResult<P extends Record<string, unknown>> {
  warrant: Warrant;
  authorized: P;
}

/**
 * Mint a warrant from a human decision. Pure over its inputs: no clock, no id source, no
 * I/O of its own, so a mint is re-derivable from the ledger rows the caller read.
 *
 * Never throws: every exit is a value, because a caller may sit inside an approval callback
 * where a rejected promise is a fail-open.
 */
export function mintHumanWarrant<P extends Record<string, unknown>>(
  opts: {
    runId: string;
    requestId: string;
    reviewId: string;
    principal: Principal;
    actionKind: string;
    /**
     * The context the original evaluation saw, read off `warrant.requested`. Re-evaluation
     * runs against this same context so the re-run answers the question the first run
     * answered; substituting a fresh or empty context would match a different rule.
     */
    originalContext: Record<string, unknown>;
    /** The submitted review content, read off the ledger and validated by nobody yet. */
    content: unknown;
    decision: HumanDecision;
    /**
     * The domain narrowing. Receives the FINAL content (the edit, when one exists) and
     * returns the addressee plus the exact params to sign, or `null` to refuse. A `null`
     * is a fail-closed refusal, not an error in the caller.
     */
    parseContent: (finalContent: unknown) => AuthorizedContent<P> | null;
  },
  deps: MintDeps,
): Result<HumanMintResult<P>, WarrantError> {
  try {
    const { decision } = opts;

    // The attestation is checked at this boundary even when the caller checked it earlier:
    // this is where authority comes into existence, and redundancy on that line is
    // deliberate (the same reasoning as the nonce's double enforcement).
    if (typeof decision.decidedBy !== 'string' || decision.decidedBy.trim() === '') {
      return err({ type: 'validation', code: 'human_attestation_missing',
        message: 'decision carries no decidedBy; a mint must name the human who decided' });
    }

    // Deny can never mint. A rejected decision reaching a mint is a caller wiring fault,
    // and the fail-closed answer is refusal, not a warrant.
    if (decision.decision !== 'approved' && decision.decision !== 'edited') {
      return err({ type: 'validation', code: 'decision_not_approvable',
        message: `decision '${decision.decision}' cannot mint a warrant` });
    }

    // An edited decision with no edit would silently authorize the ORIGINAL content under
    // an "edited" label: the exact inversion this function exists to prevent.
    if (decision.decision === 'edited' && decision.editedContent === undefined) {
      return err({ type: 'validation', code: 'edited_no_content',
        message: 'edited decision carries no editedContent' });
    }

    // The edit replaces; it never merges (header). The approved branch passes the
    // submitted content through untouched, so a null or a scalar is refused by
    // parseContent below rather than smoothed over here.
    const finalContent: unknown = decision.decision === 'edited'
      ? { ...decision.editedContent }
      : opts.content;

    const parsed = opts.parseContent(finalContent);
    if (parsed === null) {
      return err({ type: 'validation', code: 'malformed_review_content',
        message: 'final review content was refused by the caller\'s content narrowing' });
    }

    // Reconstruct the request around the FINAL content and parse it at the boundary,
    // exactly as the request path does: one source of truth for the request's shape.
    const request: ActionRequest = {
      id: opts.requestId,
      runId: opts.runId,
      principal: opts.principal,
      action: { kind: opts.actionKind, target: parsed.target, params: parsed.params },
      context: opts.originalContext,
    };
    const parsedRequest = ActionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return err({ type: 'validation', code: 'malformed_request',
        message: `reconstructed request failed schema validation: ${parsedRequest.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}` });
    }

    // Re-run policy on the FINAL content. A reviewer's edit can move the action into
    // territory the original evaluation never saw, and a warrant minted without this line
    // would attest a rule that never governed these bytes.
    const reEval = evaluate(parsedRequest.data, deps.policy);
    if (reEval.path === 'deny') {
      return err({ type: 'validation', code: 'policy_denied_on_final',
        message: `Policy denied final content: ${reEval.reason}` });
    }

    // The path is 'human' regardless of what the re-evaluation said, because it records how
    // authority arose: a person decided. The rule id is the re-evaluation's, because it
    // names the rule that actually governed the final bytes.
    const verdict: Verdict = {
      path: 'human',
      ruleId: reEval.ruleId,
      policyVersion: deps.policy.doc.version,
      policyHash: deps.policy.hash,
      reason: 'human_review',
    };

    const issued = issueWarrant(
      { request: parsedRequest.data, verdict, reviewRef: opts.reviewId, ttlMs: deps.humanTtlMs },
      { keys: deps.keys, now: deps.now, newId: deps.newId },
    );
    if (issued.error) {
      return err({ type: 'validation', code: 'issue_failed', message: issued.error.message });
    }
    const w = issued.data;

    // Defense-in-depth: the warrant's hash must be the hash of the bytes the narrowing
    // produced. If the boundary parse above ever changed the params, this is what notices.
    let ph: string;
    try { ph = paramsHash(parsed.params); } catch {
      return err({ type: 'integrity', code: 'paramshash_mismatch', message: 'paramsHash(authorized) threw' });
    }
    if (w.action.paramsHash !== ph) {
      return err({ type: 'integrity', code: 'paramshash_mismatch', message: 'issueWarrant paramsHash diverged' });
    }

    return ok({ warrant: w, authorized: parsed.params });
  } catch (e) {
    return err({ type: 'permanent', code: 'mint_internal_error',
      message: `mintHumanWarrant threw rather than returning: ${e instanceof Error ? e.message : String(e)}` });
  }
}
