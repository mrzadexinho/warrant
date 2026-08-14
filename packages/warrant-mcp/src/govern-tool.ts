/**
 * The MCP adapter. **A caller of the two seams, not a third one.**
 *
 * `governTool` wraps an MCP tool's handler so that every call runs `requestAuthority`
 * (`@idriszade/warrant-authorize`) then, on the auto path, `guardedExecute`
 * (`@idriszade/warrant-guard`). Everything between "was this permitted" and "did what executed
 * stay inside what was permitted" belongs to those two packages; this file holds only the
 * translation from an MCP tool call into their shapes, and back.
 *
 * Three paths, and only three:
 *
 *   deny  → refuse. The handler never runs. A denial is a successful decision, not an error.
 *   human → submit to the Gate, record `review.submitted`, stop. No warrant, no execution.
 *           Resume is out of scope for this package on purpose (see the adapter author's guide).
 *   auto  → guardedExecute runs the handler under the warrant it was issued.
 *
 * **The whole handler body is wrapped so it can never throw.** An MCP client sees a rejected
 * promise as a transport fault, not a refusal: the same fail-open `requestAuthority` and
 * `Gate.submit` guard themselves against (see `warrant-eve/src/approval.ts:12-14`). Every exit
 * here is a value.
 */

import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { paramsHash } from '@idriszade/warrant-core';
import type { ActionRequest, WarrantError } from '@idriszade/warrant-core';
import { requestAuthority } from '@idriszade/warrant-authorize';
import { guardedExecute } from '@idriszade/warrant-guard';
import type { ZodType } from 'zod';
import type { GovernToolDeps, McpTool, McpToolBinding, McpToolResult } from './types.js';

function refused(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Govern an MCP tool: same `name`, a `handler` that runs the call under warrant.
 */
export function governTool<I, T>(
  tool: McpTool<T>,
  binding: McpToolBinding<I>,
  schema: ZodType<T>,
  deps: GovernToolDeps,
): McpTool<I> {
  return {
    name: tool.name,
    handler: async (args: I): Promise<McpToolResult> => {
      try {
        const id = deps.newId();
        // A caller with a session supplies one and gets a run spanning it; absent that, each
        // call is its own single-action run, because this package has no session identifier it
        // is entitled to invent. See `GovernToolDeps.runId`.
        const runId = (deps.runId ?? deps.newId)();

        // **Called exactly once.** The value hashed into the warrant and the value handed to
        // the guard must be the same bytes, and `toParams` is caller-supplied: invoking it
        // twice makes that an assumption about someone else's function rather than a property
        // of this one. A binding reading anything mutable would produce a `params_mismatch`:
        // fail-closed, but failing for a reason nobody could find. Same family as the
        // GhostApproval invariant, which is about exactly this gap.
        const params = binding.toParams(args);

        const request: ActionRequest = {
          id,
          runId,
          principal: binding.principal,
          action: {
            kind: binding.actionKind,
            target: binding.toTarget(args),
            params,
          },
          context: binding.toContext(args),
        };

        const authorized = await requestAuthority(request, deps);
        if (authorized.error) {
          // Four distinct diagnoses, not one. Collapsing them is the failure mode this guard
          // exists to prevent (adapter-authors-guide.md §2).
          const { code } = authorized.error;
          const reason =
            code === 'context_noncanonical' || code === 'ledger_error' || code === 'issue_failed'
              ? code
              : 'authorize_internal_error';
          // **A fault, not a refusal, and the words have to say so.** The guide's rule (an
          // adapter must not report a ledger outage and a policy refusal identically) binds
          // the *text* here and not only the branch, because in MCP the text IS the channel:
          // `McpToolResult` carries no structured error, and its reader is usually a language
          // model deciding what to tell a person next. "denied" for an unreachable ledger
          // produces a confident, false explanation that the user lacks permission.
          return refused(`governance unavailable: ${reason}`);
        }

        const outcome = authorized.data;

        if (outcome.path === 'deny') {
          // The one case that genuinely means "you are not permitted". A successful decision,
          // which is why it reads as a verdict rather than a failure.
          return refused(`refused by policy: ${outcome.verdict.ruleId}`);
        }

        if (outcome.path === 'human') {
          // requestAuthority stopped at the verdict on purpose (adapter-authors-guide.md §5).
          // Submitting the review and recording that it was submitted is this adapter's job,
          // and the only thing it owes the ledger on this path. No warrant is minted; resume is
          // deliberately out of v1 scope, so this call ends here.
          // In MCP the text IS the channel: `McpToolResult` has no structured error and its
          // reader is usually a model deciding what to tell a person, so a governance fault
          // worded as a denial produces a confident, false claim that the user lacks
          // permission. The three refusals below must never say `denied:` for that reason.
          // Same three categories as the auto path, applied here.
          let ph: string;
          try {
            ph = paramsHash(request.action.params);
          } catch {
            // Not a denial: the caller's own params could not be canonicalised. Nothing
            // judged them and nothing refused them.
            return refused('execution refused: params_noncanonical');
          }

          const content = binding.toReviewContent(args);
          const submitResult = await deps.gate.submit({
            requestId: id,
            runId,
            title: binding.toReviewTitle(args),
            content,
            metadata: { paramsHash: ph, stakesRuleId: outcome.verdict.ruleId },
          });
          if (submitResult.error) {
            // Not a decision, on any of the four branches below: the transport failed, or
            // Gatewerk answered and declined, or it answered with a body this adapter cannot
            // use, or something nameless went wrong. None of those is a verdict, so governance
            // was not available to this call in every one of them, and `governance unavailable:`
            // is the category for all of them. Only the CODE splits by cause: a
            // 400/401/409 is Gatewerk answering promptly and refusing, which is a different fact
            // from the network being down, and collapsing the two would erase that fact (the same
            // distinction `warrant-eve/src/approval.ts:72-83` draws for the sibling runtime).
            // "refused" is deliberately not the category for the HTTP-refusal case either: this
            // adapter's whole job is to stop a governance fault reading as a
            // denial, and a category that says "refused" twice for something nobody decided
            // would reintroduce exactly that. Mirrors the eve fix in shape, not in spelling: eve
            // keeps `type: 'denied'` fixed and splits `reason`; this keeps `governance
            // unavailable:` fixed and splits the code.
            const { code } = submitResult.error;
            if (code === 'gate_unreachable') return refused('governance unavailable: gate_unreachable');
            if (code === 'gatewerk_api_error') {
              // The HTTP status is the single most actionable token here, and it is already
              // sitting in the error's own message ("${res.status} ${res.statusText}"), so it
              // rides along without restructuring refused().
              return refused(`governance unavailable: gate_refused: ${submitResult.error.message}`);
            }
            if (code === 'gatewerk_missing_review_id') return refused('governance unavailable: gate_invalid_response');
            return refused('governance unavailable: approval_internal_error');
          }

          const { reviewId } = submitResult.data;
          const appendReview = await deps.ledger.append({
            runId,
            at: deps.now().toISOString(),
            event: 'review.submitted',
            principal: binding.principal,
            payload: { requestId: id, reviewId, content },
          });
          // The review was submitted and we could not record that it was. An outage, category
          // unchanged, but a DIFFERENT point in the sequence from `requestAuthority`'s own
          // `ledger_error` above (:79-90): that one is `warrant.requested`/`policy.evaluated`/
          // `warrant.denied`/`warrant.issued` failing to append; this one is `review.submitted`
          // failing to append, after the gate already accepted the review. Two different facts
          // sharing one code is the exact duplicate-code collision fixed in
          // `warrant-eve/src/approval.ts` (`ledger_error` at :45 vs `review_append_failed` at
          // :92): same split, second runtime.
          if (appendReview.error) return refused('governance unavailable: review_append_failed');

          return refused(`pending review: ${reviewId}`);
        }

        // The auto path. The effect closure wraps the tool's own handler so a tool-reported
        // failure (`isError: true`, no throw) is recorded as one: guarded-execute.ts:135 writes
        // `status: outcome.error ? 'failed' : deps.outcomeStatus`, and this is what feeds it a
        // failure rather than a false success.
        // `guardedExecute` hands back the **parsed** params, validated and stripped by the
        // schema, and those are the bytes the authority check hashed. The handler receives
        // exactly them, never `args`, which is why `tool` is an `McpTool<T>`: what executes has
        // to be what was authorized. This used to read `params as unknown as I`, and the cast
        // was the tell: every fixture made `I` and `T` structurally identical, so nothing ever
        // failed and the type went on claiming something the code did not do.
        const effect = async (params: T): Promise<Result<McpToolResult, WarrantError>> => {
          const result = await tool.handler(params);
          if (result.isError) {
            return err<WarrantError>({
              type: 'permanent',
              code: 'tool_reported_error',
              message: result.content.map((c) => c.text).join('\n'),
            });
          }
          return ok(result);
        };

        const executed = await guardedExecute(
          outcome.warrant,
          params,
          schema,
          {
            publicKeyHex: deps.publicKeyHex,
            ledger: deps.ledger,
            now: deps.now,
            outcomeStatus: deps.outcomeStatus,
          },
          effect,
        );

        if (executed.error) {
          // tool_reported_error carries the handler's own joined text: reconstruct the tool
          // result the handler would have produced rather than warrant's own wording. Every
          // other guardedExecute error (invalid_params, params_mismatch, a thrown effect, a
          // ledger outage recording the outcome, …) is warrant's own refusal and gets its code.
          const text =
            executed.error.code === 'tool_reported_error'
              ? executed.error.message
              : `execution refused: ${executed.error.code}: ${executed.error.message}`;
          return refused(text);
        }

        return executed.data;
      } catch {
        return refused('governance_internal_error');
      }
    },
  };
}
