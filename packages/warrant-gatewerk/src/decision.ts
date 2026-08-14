// portfolio/packages/warrant-gatewerk/src/decision.ts
//
// Maps a raw Gatewerk review response to a ReviewDecision per contract C7.
// This is the second of two independent layers against the false-attestation
// hole (spec 2.2): submit() (C6) never requests oversight:'monitoring' or
// timeout.action:'auto_approve', but neither layer may rely on the other, and
// this file is what actually stands between a system-originated decision and
// a minted warrant carrying verdict.reason:'human_review'.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { ReviewDecision } from './types.js';

const PENDING_STATUSES = new Set(['pending', 'awaiting_iteration', 'awaiting_external', 'monitoring']);
const REJECTED_DECISIONS = new Set(['rejected', 'vetoed', 'max_iterations_reached', 'expired']);

// Locked implementation from master plan contract C7, widened by one
// character class after independent verification against Gatewerk's own
// source found a real bypass: apps/api/src/services/reviews/crud.ts's
// per-template auto_approve path writes decided_by:'system/auto-approve'
// (slash, not colon) when a review's template has auto_approve:true and
// oversight is not 'monitoring'. That is a real, reachable system-originated
// decider the literal C7 regex /^system:/i does not match, and it is not
// something our own submit() call controls (C6 never sets
// oversight:'monitoring' or timeout.action:'auto_approve'; auto_approve is a
// server-side TEMPLATE setting outside this client's request shape).
// Flagged to the reviewer before landing this deviation; matching both
// separators actually observed in Gatewerk's source keeps the fix anchored
// to verified evidence rather than speculative hardening.
//
// Trim FIRST, then match, case-insensitively: an earlier draft trimmed only
// for the empty-string check and left the regex untrimmed, so a single
// leading space (' system:timeout') slipped through. The case-insensitive
// flag closes the same defect class that broke a .gov protected-audience
// check in warrant-v0.1 via '.GOV'.
// Widened past the two separators actually observed (':' and '/') to ANY
// non-alphanumeric separator, or bare 'system'. Enumerating observed separators
// is a denylist: it fixes 'system/auto-approve' and reopens on the next one
// Gatewerk invents. Rejecting a human account literally named 'system_*' is the
// correct trade, because it is indistinguishable from a machine and this is the
// fail-closed direction.
function isSystemDecider(v: unknown): boolean {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' || /^system([^a-z0-9]|$)/i.test(t);
}

// A SECOND signal, independent of the decider string entirely. The same
// auto-approve block that writes decided_by:'system/auto-approve'
// (gatewerk/apps/api/src/services/reviews/crud.ts:227-229) also stamps
// action_value:'auto_approve'. Checking both means a future rename of the
// decider string cannot silently reopen the hole: two signals, one failure.
function isMachineAction(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'auto_approve';
}

// THE PRIMARY GUARD, and the only one shaped as an allowlist.
//
// decided_by is the WRONG COLUMN to attest a human on, and Gatewerk's own
// engineers say so. apps/api/src/routes/reviews/monitoring.ts:20-27 explains why
// the monitoring endpoints refuse to reuse the decide/action pipeline: "that
// surface accepts api-key actors ... and lets api-key callers spoof decided_by
// via body.reviewer ... would let the agent that created the review confirm it
// under a fake human name."
//
// Two concrete paths defeat any decided_by check:
//   routes/reviews/action.ts:104  api-key auth  -> actor {kind:'agent', id: apiKeyPrefix}
//   services/reviews/actions.ts:217              -> decided_by = actor.id, the RAW id
// so a machine approval lands as decided_by:'gwk_live_7f3a' with no marker at
// all, and routes/reviews/decide.ts:203-204 additionally lets an agent actor
// overwrite decided_by with any string it likes.
//
// last_action_by is the field Gatewerk actually maintains as '<kind>:<id>'
// (services/reviews/actions.ts:36 + :188), with kind in
// reviewer | chain | agent | external. Only 'reviewer' is an authenticated human
// session. It is exposed on the review object (shared/api/schemas/reviews.ts:217).
//
// This is an ALLOWLIST: we require positive evidence of a human session rather
// than enumerating the machine markers we happen to have seen. The denylist
// approach has now been wrong three times (untrimmed regex, 'system/auto-approve'
// with a slash, and this). A missing or null last_action_by fails closed:
// absence of proof is not proof.
function isHumanAttested(v: unknown): boolean {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return t.startsWith('reviewer:') && t.length > 'reviewer:'.length;
}

export function mapReviewDecision(json: unknown): Result<ReviewDecision | { pending: true }, WarrantError> {
  if (typeof json !== 'object' || json === null) {
    return err({ type: 'validation', code: 'unrecognized_status', message: 'Gatewerk review response was not an object' });
  }
  const r = json as {
    id?: unknown;
    status?: unknown;
    decision?: unknown;
    decided_by?: unknown;
    edited_payload?: unknown;
    action_value?: unknown;
    last_action_by?: unknown;
  };
  const status = typeof r.status === 'string' ? r.status : '';
  const reviewId = typeof r.id === 'string' ? r.id : '';

  if (PENDING_STATUSES.has(status)) return ok({ pending: true });

  // An OUTCOME with no review id is refused, not defaulted: every consumer keys on
  // reviewId (duplicate-review-claim checks included), so an approval keyed to '' makes
  // two distinct id-less approvals collide on the empty string. Scoped to the statuses
  // that produce outcomes, so unrecognizable garbage still gets the more diagnostic
  // unrecognized_status below rather than a complaint about its id.
  if (reviewId === '' && (status === 'decided' || status === 'expired' || status === 'archived')) {
    return err({
      type: 'validation',
      code: 'review_id_missing',
      message: 'review has no id; a decision that cannot be keyed is refused',
    });
  }

  // The ONE place a system decider is allowed: it maps to a denial (the
  // fail-closed direction), never to a mintable outcome.
  if (status === 'expired' || status === 'archived') {
    return ok({ reviewId, decision: 'rejected', decidedBy: `system:${status}` });
  }

  if (status !== 'decided') {
    return err({
      type: 'validation',
      code: 'unrecognized_status',
      message: `unrecognized review status: ${status || '(missing)'}`,
    });
  }

  // Check the decider BEFORE branching on the decision value. Gatewerk's
  // closeMaxIterations writes decision:'max_iterations_reached' (one of the
  // values that maps to a human rejection below) together with
  // decided_by:'system:max_iterations'. If the decision branch ran first,
  // that combination would be silently accepted as a valid human rejection
  // instead of failing closed with an honest error. The same reasoning
  // applies to every decision value: a system decider must never reach a
  // decision branch, approving or otherwise.
  // Positive proof of a human session comes FIRST. The two checks below remain
  // as defense in depth, but they are denylists and must never be the only
  // thing standing between a machine decision and a minted warrant.
  if (!isHumanAttested(r.last_action_by)) {
    return err({
      type: 'validation',
      code: 'human_attestation_missing',
      message: `no human reviewer session on this decision: last_action_by=${String(r.last_action_by)}`,
    });
  }
  if (isSystemDecider(r.decided_by)) {
    return err({
      type: 'validation',
      code: 'human_attestation_missing',
      message: `decided_by was not a human identity: ${String(r.decided_by)}`,
    });
  }
  // Independent of the decider entirely: a machine action_value denies even
  // when decided_by looks perfectly human.
  if (isMachineAction(r.action_value)) {
    return err({
      type: 'validation',
      code: 'human_attestation_missing',
      message: `review carried a machine action_value: ${String(r.action_value)}`,
    });
  }
  const decidedBy = r.decided_by as string;

  const decision = typeof r.decision === 'string' ? r.decision : '';
  // APPROVE-WITH-EDITS. Gatewerk's human surfaces never send decision:'edited'.
  // The inbox sends decision:'approved' carrying edited_payload
  // (apps/web/src/pages/inbox/use-inbox-keyboard-shortcuts.ts:190), and the
  // action route resolves the 'approve' preset to decision_value 'approved' while
  // persisting edited_payload (services/reviews/execute-action.ts:236-241).
  // Grepping apps/web, apps/web-next and packages/sdk-ts finds no caller that
  // sends 'edited' at all, so treating edits as significant only under that value
  // meant a reviewer's corrections were silently discarded: the warrant would be
  // minted over the ORIGINAL params while the certificate attested that a human
  // approved. The agent would send exactly the content the human edited away.
  //
  // So edited_payload is authoritative WHENEVER it is present, independent of the
  // decision value. Routing it through the 'edited' outcome is deliberate: that is
  // the path that re-binds params and re-runs policy on the FINAL content, which
  // is what binds the warrant to the bytes the human actually authorized.
  if (decision === 'approved' || decision === 'edited') {
    const edited = r.edited_payload;
    const hasEdits = typeof edited === 'object' && edited !== null && Object.keys(edited).length > 0;
    if (hasEdits) {
      return ok({
        reviewId,
        decision: 'edited',
        editedContent: edited as ReviewDecision['editedContent'],
        decidedBy,
      });
    }
    if (decision === 'edited') {
      // An explicit 'edited' with nothing to apply is incoherent: fail closed
      // rather than guess whether the human meant to change something.
      return err({ type: 'validation', code: 'edited_no_content', message: 'edited decision carried no edited_payload' });
    }
    return ok({ reviewId, decision: 'approved', decidedBy });
  }
  if (REJECTED_DECISIONS.has(decision)) return ok({ reviewId, decision: 'rejected', decidedBy });
  return err({
    type: 'validation',
    code: 'unrecognized_decision',
    message: `unrecognized review decision: ${decision || '(missing)'}`,
  });
}
