// portfolio/packages/warrant-gatewerk/src/types.ts
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

/**
 * What a human reads and may edit: a set of named fields the Gatewerk template
 * renders.
 *
 * DELIBERATELY OPAQUE. Two independent reasons, either sufficient on its own.
 *
 * 1. The shape is not warrant's to name. The boundary register puts human
 *    decision content (text, edits, forms) in Gatewerk, under the test "can a
 *    person type into it?". This package is warrant's *adapter to* that port,
 *    and an adapter that declares the shape of the thing on the far side has
 *    quietly taken ownership of it. The shape lives in the Gatewerk template.
 *
 * 2. A concrete type here would be false. This value arrives over HTTP from
 *    Gatewerk, and `mapReviewDecision` can only establish that it is a non-empty
 *    object before handing it on (`decision.ts`, the `hasEdits` check and the
 *    cast beneath it). Anything more specific is a compile-time claim about a
 *    runtime value that crossed a trust boundary. Consumers therefore
 *    shape-guard it themselves: `warrant-eve`'s `isEmailContent` was already
 *    doing exactly that while this type still claimed `{subject, body, to}`,
 *    which is the proof the claim was never load-bearing. **A type that lies is
 *    worse than an opaque one, because it stops the reader asking for a guard.**
 *
 * A concrete email shape (`{ subject: string; body: string; to: string }`) would use two words
 * (`subject`, `recipient`) that fail a forbidden-word test in both `warrant-guard` and
 * `warrant-authorize`, the same vocabulary this package is meant to stay blind to.
 */
export type ReviewContent = Record<string, unknown>;

export interface ReviewRequest {
  requestId: string;
  runId: string;
  title: string;
  content: ReviewContent;
  metadata: { paramsHash: string; stakesRuleId: string };
}

export interface ReviewDecision {
  reviewId: string;
  decision: 'approved' | 'edited' | 'rejected';
  /**
   * Authoritative whenever present, independent of the decision value
   * (`decision.ts`). Opaque for the same reasons as `ReviewContent`, and with
   * the same obligation on the caller: shape-guard it before it reaches params.
   */
  editedContent?: ReviewContent;
  // Required on every non-pending outcome (C7): the identity that decided the
  // review. mapReviewDecision never returns a ReviewDecision without one, a
  // system-originated decider is rejected before a ReviewDecision is built.
  decidedBy: string;
}

export interface Gate {
  submit(r: ReviewRequest): Promise<Result<{ reviewId: string }, WarrantError>>;
  fetchDecision(reviewId: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>>;
}
