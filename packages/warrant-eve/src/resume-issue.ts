/**
 * resume-issue.ts: approved/edited branch of resumeByPoll.
 *
 * The mint itself lives in `@idriszade/warrant-authorize` (`mintHumanWarrant`,
 * `mint-human-warrant.ts`): it was extracted when a second consumer of the
 * mint-from-human-attestation primitive arrived. What remains here is the part the kernel
 * cannot own: the domain narrowing. The kernel cannot read `.to`, so this module supplies
 * `parseContent`, which narrows the final reviewed content to an email and names
 * `authorized.to` as the signed `action.target`, recomputed from the FINAL content, so a
 * reviewer who corrects the recipient moves the target with it.
 */
import type { Result } from '@idriszade/core';
import { mintHumanWarrant as mintFromHumanDecision } from '@idriszade/warrant-authorize';
import type { Principal, Warrant, WarrantError } from '@idriszade/warrant-core';
import type { ReviewDecision } from '@idriszade/warrant-gatewerk';
import type { WarrantEveDeps } from './deps.js';

/**
 * CONCRETE ON PURPOSE. The `Gate` port's content is opaque because the port reads no field
 * of it anywhere. That argument does not reach here: this module reads the content.
 * `isEmailContent` checks three fields by name, fail-closed, and `authorized.to` becomes
 * the signed `action.target`.
 *
 * This is the type of the guard's OUTPUT, not a claim about an incoming value. `raw` is
 * `unknown` until `isEmailContent` narrows it. Deleting the alias would relocate the
 * domain knowledge into an unnamed inline predicate, not remove it.
 *
 * `warrant-eve` is `kernel: false`, warrant's adapter to one agent runtime, and none of
 * this is on the package's public surface (`src/index.ts` exports neither this type nor
 * `mintHumanWarrant`; `resume.ts` is the only importer).
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

/**
 * Thin composition over the kernel mint: this adapter's whole contribution is the email
 * narrowing. The kernel owns the sequence (edit replaces original, shape refusal,
 * boundary re-parse, re-evaluation on the final content, issue, paramsHash cross-check)
 * and re-checks the attestation and the edited/no-content cases that `resume.ts` already
 * refuses upstream: deliberate redundancy at the line where authority comes into
 * existence, the same family as the nonce's double enforcement.
 *
 * `content` stays `unknown`: it is read straight off a ledger payload and validated by
 * nobody until the kernel hands it to `isEmailContent` (a null content row makes a
 * narrower type false; pinned by `tests/mint-guards.test.ts`).
 */
export async function mintHumanWarrant(opts: {
  deps: WarrantEveDeps;
  runId: string;
  reviewId: string;
  requestId: string;
  content: unknown;
  principal: Principal;
  decision: ReviewDecision;
  actionKind: string;
  originalContext: Record<string, unknown>;
}): Promise<Result<MintResult, WarrantError>> {
  const { deps, decision } = opts;
  return mintFromHumanDecision<EmailContent>(
    {
      runId: opts.runId,
      requestId: opts.requestId,
      reviewId: opts.reviewId,
      principal: opts.principal,
      actionKind: opts.actionKind,
      originalContext: opts.originalContext,
      content: opts.content,
      decision,
      parseContent: (finalContent) =>
        isEmailContent(finalContent) ? { target: finalContent.to, params: finalContent } : null,
    },
    {
      policy: deps.policy,
      keys: deps.keys,
      now: deps.now,
      newId: deps.newId,
      humanTtlMs: deps.humanTtlMs,
    },
  );
}
