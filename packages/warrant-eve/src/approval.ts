import type { ApprovalStatus, ApprovalContext } from 'eve/tools';
import { paramsHash } from '@idriszade/warrant-core';
import type { ActionRequest } from '@idriszade/warrant-core';
import { requestAuthority } from '@idriszade/warrant-authorize';
import type { ReentryCheckInfo, WarrantEveDeps, WarrantToolBinding } from './deps.js';
import { findByRequestId } from './correlate.js';

export function buildApproval<I, P>(
  binding: WarrantToolBinding<I, P>,
  deps: WarrantEveDeps,
): (ctx: ApprovalContext<I>) => Promise<ApprovalStatus> {
  return async (ctx: ApprovalContext<I>): Promise<ApprovalStatus> => {
    // [CRITICAL]: entire body is wrapped; any unguarded throw RESOLVES denied, never rejects.
    // requestAuthority is wrapped the same way for the same reason, so this catch now covers
    // the binding calls and the gate rather than the ledger sequence.
    try {
      const input = ctx.toolInput;
      if (input === undefined) return { type: 'denied', reason: 'no_input' };

      const id = ctx.callId;
      const runId = ctx.session.id;

      // ── RE-ENTRY GUARD ────────────────────────────────────────────────────────────────────
      // **eve re-invokes this callback when a parked call is resumed**, carrying the **same
      // `callId`**. Without this guard the entire human path runs a second time:
      // `requestAuthority` appends a duplicate `warrant.requested` + `policy.evaluated`, policy
      // reaches `human` again, and then `gate.submit` sends `idempotency_key: requestId`
      // (`gatewerk-gate.ts`), a key Gatewerk has already seen for the first submission, and
      // refuses it. **The run then stops with nothing appended at all**, because a submit
      // failure returns a denial and writes no ledger entry.
      //
      // A resumed call is *supposed* to carry the same id; it is the re-entry that must stop,
      // never the shared callId itself.
      //
      // **This is NOT the security boundary and must not be read as one.** Returning 'approved'
      // only lets eve proceed to `execute`, which independently re-reads the warrant for this
      // exact `(runId, callId)`, requires **exactly one** `warrant.issued`, verifies the
      // signature, recomputes the params hash against the signed bytes and spends the nonce
      // (`execute.ts` → `verifyAuthorizedParams`). A wrong 'approved' here cannot execute an
      // unauthorized action: it fails at the guard as `warrant_missing`. The guard stays the
      // only thing standing between authority and a side effect.
      //
      // A ledger read that fails is a **denial with its own reason**, never a fall-through: this
      // check cannot tell "no prior outcome" from "cannot see the ledger", and falling through
      // would re-run the exact sequence this guard exists to prevent.
      // **SCOPED TO THE HUMAN PATH BY `reviewRef`, and the first version of this guard was not.**
      // `resumeByPoll` writes its terminal outcome with a `reviewRef`; the auto path's
      // `warrant.issued` has none. Without that filter this became a general approval dedup, and
      // `guard-contracts.test.ts` failed **by design**: its premise is asserted, not assumed:
      // *"if approval ever gains a dedup this fails loudly instead of the test passing for the
      // wrong reason."* It was right to. Auto-path calls never park, so they never re-enter, and
      // deduping them would move a security property out of `execute`'s exactly-one check into a
      // softer layer while making the double-mint case unreachable for the tests that cover it.
      //
      // **Exactly one, never a first match.** `correlate.ts` explains why `execute.ts` keeps its
      // own stricter lookup, and this position has the same obligation: two human-path warrants
      // for one call disagree about what was authorized, and picking the earlier one invents an
      // answer. Ambiguity is a refusal here too: `execute` would refuse anyway, and a guard that
      // says 'approved' into a state the guard below rejects is a worse error message, not a
      // safer system.
      // The guard REPORTS every evaluation, `proceed` included: a per-evaluation report makes a
      // stale running image observable at the moment it matters: an approval logged with no
      // guard line beside it ran on a stale image. The reporter can never break an approval;
      // thrown errors are swallowed, like resume.ts's deliver reporter.
      const report = (entries: number, matched: number, decision: ReentryCheckInfo['decision']): void => {
        try {
          if (deps.onReentryCheck) {
            deps.onReentryCheck({ runId, callId: id, entries, matched, decision });
          } else if (decision !== 'proceed') {
            // eslint-disable-next-line no-console
            console.error(
              `[warrant-eve] re-entry guard: ${decision} (entries=${entries}, matched=${matched}, runId=${runId}, callId=${id})`,
            );
          }
        } catch { /* a reporter must never change an approval outcome */ }
      };

      const priorRead = await deps.ledger.readRun(runId);
      if (priorRead.error) {
        report(0, 0, 'read_failed');
        return { type: 'denied', reason: 'reentry_check_failed' };
      }
      const resumed = priorRead.data.filter(
        e =>
          (e.event === 'warrant.issued' || e.event === 'warrant.denied') &&
          typeof e.payload === 'object' && e.payload !== null &&
          typeof (e.payload as Record<string, unknown>)['reviewRef'] === 'string' &&
          findByRequestId([e], e.event, id) !== undefined,
      );
      if (resumed.length > 1) {
        report(priorRead.data.length, resumed.length, 'ambiguous');
        return { type: 'denied', reason: 'ambiguous_prior_outcome' };
      }
      if (resumed.length === 1) {
        const issued = resumed[0]!.event === 'warrant.issued';
        report(priorRead.data.length, 1, issued ? 'prior_approved' : 'prior_denied');
        return issued ? 'approved' : { type: 'denied', reason: 'already_denied' };
      }
      report(priorRead.data.length, 0, 'proceed');

      const target = binding.toTarget(input);

      // Translating eve's call into an ActionRequest is this adapter's whole job on the way in.
      // Everything after it (hash the context, record the request, evaluate, record the
      // verdict, record the outcome) is the authorization seam, and lives in
      // @idriszade/warrant-authorize because Millwerk is a second real consumer of it and is
      // not an eve tool. A second copy of that sequence would be a second source of truth for
      // whether policy was ever consulted.
      const request: ActionRequest = {
        id,
        runId,
        principal: binding.principal,
        action: { kind: binding.actionKind, target, params: binding.toParams(input) },
        context: binding.toContext(input),
      };

      const authorized = await requestAuthority(request, deps);
      if (authorized.error) {
        // Each reason is a distinct diagnosis an operator can act on. Collapsing them into the
        // catch-all is the failure mode these guards exist to prevent: a ledger outage, an
        // unhashable context and a key that cannot sign all stop the run, and only one of them
        // is the operator's to fix.
        const { code } = authorized.error;
        if (code === 'context_noncanonical') return { type: 'denied', reason: 'context_noncanonical' };
        if (code === 'ledger_error') return { type: 'denied', reason: 'ledger_error' };
        if (code === 'issue_failed') return { type: 'denied', reason: 'issue_failed' };
        return { type: 'denied', reason: 'approval_internal_error' };
      }

      const outcome = authorized.data;
      if (outcome.path === 'deny') return { type: 'denied', reason: outcome.verdict.ruleId };
      if (outcome.path === 'auto') return 'approved';

      // Human path. requestAuthority stops at the verdict because a review's content is
      // domain-shaped and the boundary register puts human decision content in Gatewerk;
      // submitting it is the adapter's job, along with recording that it was submitted.
      let ph: string;
      try {
        ph = paramsHash(request.action.params);
      } catch {
        return { type: 'denied', reason: 'params_noncanonical' };
      }

      const reviewContent = binding.toReviewContent(input);
      const submitResult = await deps.gate.submit({
        requestId: id,
        runId,
        title: binding.toReviewTitle(input),
        content: reviewContent,
        metadata: { paramsHash: ph, stakesRuleId: outcome.verdict.ruleId },
      });
      if (submitResult.error) {
        // Same discipline as the requestAuthority switch above: GatewerkGate#submit
        // distinguishes a genuine transport failure from an HTTP refusal from an
        // unusable 2xx body, and collapsing all three into one reason erases that
        // distinction downstream, where an operator is trying to tell "the gate is
        // down" from "the gate said no" from "the gate answered garbage."
        const { code } = submitResult.error;
        if (code === 'gate_unreachable') return { type: 'denied', reason: 'gate_unreachable' };
        if (code === 'gatewerk_api_error') return { type: 'denied', reason: 'gate_refused' };
        if (code === 'gatewerk_missing_review_id') return { type: 'denied', reason: 'gate_invalid_response' };
        return { type: 'denied', reason: 'approval_internal_error' };
      }

      const appendReview = await deps.ledger.append({
        runId,
        at: deps.now().toISOString(),
        event: 'review.submitted',
        principal: binding.principal,
        payload: { requestId: id, reviewId: submitResult.data.reviewId, content: reviewContent },
      });
      if (appendReview.error) return { type: 'denied', reason: 'review_append_failed' };

      return 'user-approval';
    } catch {
      return { type: 'denied', reason: 'approval_internal_error' };
    }
  };
}
