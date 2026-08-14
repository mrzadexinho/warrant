/**
 * The authorization seam. **One request path, many runtimes.**
 *
 * The proof spine of authorization is this sequence, in this order:
 *
 *   hash the context → record the request → evaluate → record the evaluation WITH that hash
 *   → record the outcome
 *
 * It is the half of the certificate that says an action was *permitted*; `warrant-guard` owns
 * the half that says an action *stayed inside what was permitted*. A duplicate adapter is a
 * Tuesday. A second copy of this sequence is a second source of truth for whether policy was
 * ever consulted, which is the same class of defect as a second guard, and it is why this lives
 * in its own package: the dependency graph, not discipline, is what keeps it single.
 *
 * **This function knows nothing about the runtime that called it.** It takes an
 * `ActionRequest`, already built by whatever binding or composer the caller has, and hands
 * back a verdict and, on the auto path, a warrant. It does not know what an approval callback
 * is, what a call identifier is, or what a tool is.
 *
 * ## Why it stops before the Gate
 *
 * Submitting a review needs review *content*, and content is domain-shaped: an adapter types
 * it in the vocabulary of whatever is being reviewed. The boundary register puts human decision
 * content in Gatewerk. Pulling a `Gate` in here would drag review presentation into a primitive
 * whose entire claim is that it knows nothing about the runtime, and the first adapter with an
 * awkward content shape would start bending this function toward itself.
 *
 * So the split is: **this owns the proof spine of authorization; the caller submits the review
 * and appends `review.submitted`.** On the human path this returns the verdict and stops. The
 * ledger between those two points is complete either way: `warrant.requested` and
 * `policy.evaluated` are already written when the caller takes over.
 *
 * That claim is enforced, not asserted: `tests/runtime-blind.test.ts` pins the dependency set
 * exactly, notably excluding the Gate package and any agent runtime, and scans this
 * directory's source, comments included, for runtime and domain words.
 */

import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { ActionRequestSchema, canonicalJson, issueWarrant, sha256Hex } from '@idriszade/warrant-core';
import type {
  ActionRequest,
  KeyPair,
  Verdict,
  Warrant,
  WarrantError,
} from '@idriszade/warrant-core';
import type { Ledger } from '@idriszade/warrant-ledger';
import { evaluate } from '@idriszade/warrant-policy';
import type { PolicyDoc } from '@idriszade/warrant-policy';

export interface AuthorizeDeps {
  policy: { doc: PolicyDoc; hash: string };
  keys: KeyPair;
  ledger: Ledger;
  now: () => Date;
  newId: () => string;
  autoTtlMs: number;
}

/**
 * What the policy decided, and what that entitles the caller to do next.
 *
 * A warrant appears on the auto path only. `deny` carries the verdict rather than an error
 * because a refusal is a successful authorization decision: the sequence ran, and the ledger
 * records that it ran. Only a failure to *perform* the sequence is an `err`.
 */
export type AuthorizeOutcome =
  | { path: 'auto'; verdict: Verdict; warrant: Warrant }
  | { path: 'human'; verdict: Verdict }
  | { path: 'deny'; verdict: Verdict };

/**
 * Wrap a failed `ledger.append` as this primitive's own error, **carrying the cause's `type`
 * forward, never asserting one.**
 *
 * `type` is the **retry semantics**, and `Ledger.append` genuinely produces more than one. `postgres.ts`
 * emits `noncanonical_payload` as `type: 'integrity'` and `db_error` as `type: 'transient'`, and
 * both are reachable at the four call sites below. Relabelling the first as the second does not
 * merely lose a diagnosis: **it inverts the retry hint**, handing both runtimes a permanent,
 * caller-side, structural fault dressed as something worth trying again. A caller that retries a
 * `noncanonical_payload` unchanged can never succeed.
 *
 * **`code` deliberately stays `ledger_error`, and that is not the same mistake one level down.**
 * *The category says what kind of fault and therefore what to do; the code says which fault.* Here
 * `ledger_error` is the truthful category: the authorization sequence could not write to the
 * ledger, and it is the stable surface every caller of this primitive switches on. (Callers are
 * deliberately not named here: this package is runtime-blind, and `tests/runtime-blind.test.ts`
 * enforces that against its own source.)
 *
 * Propagating `cause.code` instead was considered and **rejected**: it would stop those switches
 * matching, so every ledger failure would fall through to a catch-all, converting a specific
 * diagnosis into a generic one, which is precisely the defect being fixed here, reappearing one
 * layer out. **What would beat that argument:** callers learning the ledger's code vocabulary
 * deliberately, at which point this helper can spread the cause. That is a coordinated change
 * across three packages, not a line in this one.
 *
 * The cause's own code is therefore carried in the **message**, where it is not load-bearing for
 * any switch but is the first thing an operator reads.
 */
const ledgerError = (event: string, cause: WarrantError): WarrantError => ({
  type: cause.type,
  code: 'ledger_error',
  message: `${event} append failed: ${cause.code}: ${cause.message}`,
});

/**
 * Record the request, evaluate it, and record what came of that.
 *
 * **The whole body is wrapped so it can never throw.** A caller may be an approval callback in
 * an agent runtime, where a rejected promise is a fail-open: the runtime sees a broken adapter
 * rather than a refusal, and what happens next is the runtime's guess. Every exit is a value.
 */
export async function requestAuthority(
  request: ActionRequest,
  deps: AuthorizeDeps,
): Promise<Result<AuthorizeOutcome, WarrantError>> {
  try {
    // Parse at the boundary, before anything is recorded. Without this, a request missing
    // its id minted a full warrant while every ledger entry carried requestId: undefined,
    // an audit trail that cannot correlate the run back to anything the caller named. The
    // schema also enforces the target-length cap, so evaluate()'s own guard is the second
    // layer rather than the only one. Parsed output is used from here on: Zod strips
    // nothing load-bearing (context and params are open by design), and one source of
    // truth for the request's shape beats two.
    const parsedRequest = ActionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return err<WarrantError>({
        type: 'validation',
        code: 'malformed_request',
        message: `request failed schema validation: ${parsedRequest.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      });
    }
    request = parsedRequest.data;
    const { id, runId, principal } = request;
    const at = (): string => deps.now().toISOString();

    // Bind the context the engine will actually see. evaluate() is pure over (request, policy),
    // so history reaches it through request.context and nowhere else, which means a verdict
    // depending on context is only re-derivable from the ledger if the ledger ties the context
    // to the evaluation.
    //
    // Computed BEFORE the first append so a context that cannot be canonicalised refuses under
    // its own name. entryHash canonicalises the whole payload one step below and would throw on
    // it anyway, landing in the outer catch as a generic internal error.
    let contextHash: string;
    try {
      contextHash = sha256Hex(canonicalJson(request.context));
    } catch (e) {
      return err<WarrantError>({
        type: 'validation',
        code: 'context_noncanonical',
        message: `context could not be canonicalised: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // Step 1: record what was asked for, before anything judges it. A run whose ledger holds a
    // verdict and no request cannot be replayed against the policy that produced it.
    const requested = await deps.ledger.append({
      runId,
      at: at(),
      event: 'warrant.requested',
      principal,
      payload: {
        requestId: id,
        actionKind: request.action.kind,
        target: request.action.target,
        context: request.context,
      },
    });
    if (requested.error) return err(ledgerError('warrant.requested', requested.error));

    // Step 2: evaluate, and record the evaluation together with the hash of the context it saw.
    // A failure here refuses: an evaluation nobody can prove happened is not an authorization.
    const verdict = evaluate(request, deps.policy);
    const evaluated = await deps.ledger.append({
      runId,
      at: at(),
      event: 'policy.evaluated',
      principal,
      payload: { requestId: id, ruleId: verdict.ruleId, path: verdict.path, contextHash },
    });
    if (evaluated.error) return err(ledgerError('policy.evaluated', evaluated.error));

    // Step 3: deny. Refusing and failing to write down that we refused are different facts, and
    // only one of them is true, so an unrecorded denial is an error rather than a `deny`.
    if (verdict.path === 'deny') {
      const denied = await deps.ledger.append({
        runId,
        at: at(),
        event: 'warrant.denied',
        principal,
        payload: { requestId: id, reason: 'policy_denied:' + verdict.ruleId },
      });
      if (denied.error) return err(ledgerError('warrant.denied', denied.error));
      return ok<AuthorizeOutcome>({ path: 'deny', verdict });
    }

    // Step 4: auto. Mint, then record, then hand the warrant back. An unrecorded warrant is not
    // an authorization either: the actuator re-reads its authority from the ledger, so returning
    // one that never landed there would be handing out a token nothing downstream can find.
    if (verdict.path === 'auto') {
      const issued = issueWarrant(
        { request, verdict, ttlMs: deps.autoTtlMs },
        { keys: deps.keys, now: deps.now, newId: deps.newId },
      );
      if (issued.error) {
        return err<WarrantError>({
          type: 'validation',
          code: 'issue_failed',
          message: `warrant could not be issued: ${issued.error.message}`,
        });
      }
      const warrant = issued.data;
      const appendIssued = await deps.ledger.append({
        runId,
        at: at(),
        event: 'warrant.issued',
        principal,
        payload: { requestId: id, warrantId: warrant.id, warrant },
      });
      if (appendIssued.error) return err(ledgerError('warrant.issued', appendIssued.error));
      return ok<AuthorizeOutcome>({ path: 'auto', verdict, warrant });
    }

    // Step 5: human. The proof spine is complete and the decision is not ours to route. See the
    // header: the caller owns the review, because the review's content is domain-shaped.
    return ok<AuthorizeOutcome>({ path: 'human', verdict });
  } catch (e) {
    return err<WarrantError>({
      type: 'permanent',
      code: 'authorize_internal_error',
      message: `requestAuthority threw rather than returning: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
