import type { PolicyDoc } from '@idriszade/warrant-policy';
import type { KeyPair, Principal } from '@idriszade/warrant-core';
import type { Ledger } from '@idriszade/warrant-ledger';
import type { Gate, ReviewContent } from '@idriszade/warrant-gatewerk';
import type { ParkStore } from './park-store.js';

export type EveTool<I, O = unknown> = import('eve/tools').ToolDefinition<I, O>;
export type EveApprovalCtx<I> = import('eve/tools').ApprovalContext<I>;
export type EveToolCtx = import('eve/tools').ToolContext;

export interface WarrantEveDeps {
  policy: { doc: PolicyDoc; hash: string };
  keys: KeyPair;
  publicKeyHex: string;
  ledger: Ledger;
  gate: Gate;
  now: () => Date;
  newId: () => string;
  autoTtlMs: number;
  humanTtlMs: number;
  reviewTimeoutMs: number;
  parkStore: ParkStore;
  /**
   * Called when waking the parked agent runtime fails after a decision has already been recorded.
   * **Optional, and it defaults to a `console.error` rather than to silence**: a failed wake-up
   * must never be unobservable.
   *
   * **Why the failure is still swallowed rather than propagated.** By the time `deliver` runs, the
   * ledger already holds `review.decided` and the mint, and those are authoritative. Turning a
   * failed wake-up into a failed resume would invite the caller to retry a sequence whose ledger
   * half already succeeded. So the control flow is unchanged on purpose; what changes is that the
   * failure is now *visible*.
   *
   * **Why observability matters here specifically.** A failed wake-up and a completed run are
   * byte-identical from outside without it: warrant minted, webhook handler 200, Gatewerk
   * `delivered`, outbox empty, nothing logged anywhere: a real ceremony can reach a real human
   * approval, mint a real signed warrant, and stall with no signal that it happened.
   */
  onDeliverError?: (info: {
    site: string;
    outcome: 'approved' | 'denied';
    error: unknown;
  }) => void;
  /**
   * Called by `buildApproval`'s re-entry guard on EVERY evaluation, `proceed` included.
   *
   * The `proceed` report is the point, not an accident: a process serving the resume that was
   * started before the guard existed (a rebuilt bundle sitting on disk while the old image kept
   * the port) leaves nothing to say whether the guard ran. A guard that reports every evaluation
   * makes that failure mode diagnosable by silence: **an approval in the log with no guard line
   * next to it is an approval the deployed guard never saw.** The ceremony wires this to a
   * `console.error` line for exactly that reason.
   *
   * Optional. Without it, the guard logs to `console.error` only for decisions other than
   * `proceed` (re-entries and failures are rare and always worth a line; `proceed` on every
   * first-time approval would drown test output). A reporter that throws is swallowed; it must
   * never change an approval outcome (same rule as `onDeliverError`'s reporter in `resume.ts`).
   */
  onReentryCheck?: (info: ReentryCheckInfo) => void;
}

/** What the re-entry guard saw and decided, reported per evaluation. */
export interface ReentryCheckInfo {
  runId: string;
  callId: string;
  /** How many ledger entries `readRun` returned (0 when the read itself failed). */
  entries: number;
  /** How many of them matched the human-path terminal-outcome filter. */
  matched: number;
  decision: 'proceed' | 'prior_approved' | 'prior_denied' | 'ambiguous' | 'read_failed';
}

/**
 * How an eve tool call becomes an `ActionRequest`, and, only on the human path, a review.
 *
 * **Two type parameters, and they are different types on purpose.** `I` is what the *caller*
 * hands the tool. `P` is what `toParams` produces: the value the warrant's `paramsHash` is taken
 * over, and therefore the only value the tool's own handler is ever allowed to run on. They
 * coincide often enough that `P` defaults to `I`, but a binding that projects, renames or drops
 * a field names its own `P`, and then the handler must be typed over that, which is what makes
 * the mismatch a compile error instead of an `undefined` read at runtime.
 *
 * This is not a style matter. What executes must be what was authorized: on the human path a
 * reviewer may edit the params, and a handler running against the caller's original input would
 * execute something nobody approved. `warrant-mcp` types the same property the same way.
 */
export interface WarrantToolBinding<I, P = I> {
  actionKind: string;
  principal: Principal;
  toTarget: (i: I) => string;
  toParams: (i: I) => P;
  toContext: (i: I) => Record<string, unknown>;
  toReviewTitle: (i: I) => string;
  // Opaque on purpose: the `Gate` port's content type is domain-blind, so a binding names
  // whatever fields its own Gatewerk template renders, and warrant never learns
  // which. The concrete shape belongs in the binding, e.g. the outbound demo's.
  toReviewContent: (i: I) => ReviewContent;
}
