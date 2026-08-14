// resume.ts: resumeByPoll claims review.decided BEFORE minting or denying.
// Idempotency is keyed on the CLAIM, not on warrant.issued/warrant.denied: a losing racer's
// claim append fails duplicate_review_claim before any warrant can exist for it (the TOCTOU
// this closes). A crash between the claim append and the outcome append leaves an orphaned
// claim (no outcome yet, step 3b below): that case falls through to steps 4-9 with the claim
// append skipped, and the outcome append (warrant.issued or the human-path warrant.denied) is
// independently guarded by warrant-ledger's (event, reviewRef) unique index, so even
// two racers both landing on the orphaned-claim path collide safely at the mint step instead
// of double-minting.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { verifyChain } from '@idriszade/warrant-verify';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import type { WarrantEveDeps } from './deps.js';
import { mintHumanWarrant } from './resume-issue.js';
import { findByRequestId } from './correlate.js';

type TerminalOutcome = 'issued' | 'denied';

/**
 * Wake the parked runtime, and **report a failure rather than swallowing it**.
 *
 * A bare `catch { swallow }` would be wrong here: a duplicate resume legitimately throws
 * "already resumed", but the same bare catch would also absorb *"session not found"*, which is
 * a **stalled run**, and the two would become indistinguishable from every vantage point: the
 * warrant mints, the webhook handler returns 200, Gatewerk records `delivered`, the outbox stays
 * empty, and nothing anywhere says why.
 *
 * **Control flow is deliberately unchanged.** The ledger already holds the decision and the mint
 * by this point, and those are authoritative; failing the resume would invite a retry of a
 * sequence whose ledger half already succeeded. The return value lets a caller that wants to know
 * find out, and the default reporter means a caller who wires nothing still cannot be blind.
 */
async function tryDeliver(
  deliver: (o: 'approved' | 'denied') => Promise<void>,
  outcome: 'approved' | 'denied',
  deps: WarrantEveDeps,
  site: string,
): Promise<boolean> {
  try {
    await deliver(outcome);
    return true;
  } catch (error) {
    const report = deps.onDeliverError ?? ((info: { site: string; outcome: string; error: unknown }) => {
      const msg = info.error instanceof Error ? info.error.message : String(info.error);
      // eslint-disable-next-line no-console
      console.error(
        `[warrant-eve] deliver failed at ${info.site} (outcome=${info.outcome}): ${msg}; ` +
        `the decision and the mint ARE recorded in the ledger; the parked runtime was not woken.`,
      );
    });
    try { report({ site, outcome, error }); } catch { /* a reporter must never break the resume */ }
    return false;
  }
}

function payload(e: LedgerEntry): Record<string, unknown> {
  return (typeof e.payload === 'object' && e.payload !== null)
    ? e.payload as Record<string, unknown>
    : {};
}

/**
 * `findByRequestId` lives in `./correlate.ts`, shared with `approval.ts`. **The reasoning that
 * earned it is kept here because this is where a reader tracing a provenance mismatch lands:**
 *
 * **The `requestId !== ''` guard is a security control, not defensive noise.** A naive compare
 * of `payload['requestId'] === requestId`, with `requestId` reached through an `as string` cast
 * off a ledger payload, could see either side arrive as `undefined`, and **`undefined ===
 * undefined` is true.** A `review.submitted` carrying no `requestId` would then match a
 * `warrant.requested` carrying no `requestId`, step 4's provenance check would pass
 * **vacuously**, and the run would proceed to a fully signed `warrant.issued`.
 */

// null: a claim exists but neither a warrant.issued nor a warrant.denied is visible yet
// (a concurrent winner mid-flight, or this caller's own earlier outcome-append that failed
// transiently). Callers fall through and retry rather than inventing an outcome.
async function deriveClaimedOutcome(
  entries: LedgerEntry[], requestId: string, deliver: (o: 'approved' | 'denied') => Promise<void>,
  deps: WarrantEveDeps,
): Promise<TerminalOutcome | null> {
  if (findByRequestId(entries, 'warrant.issued', requestId)) { await tryDeliver(deliver, 'approved', deps, 'claimed:issued'); return 'issued'; }
  if (findByRequestId(entries, 'warrant.denied', requestId)) { await tryDeliver(deliver, 'denied', deps, 'claimed:denied'); return 'denied'; }
  return null;
}

// Appends a terminal outcome (warrant.issued, or the human-path warrant.denied, both carry
// reviewRef). If a concurrent resume already recorded ITS outcome for this same reviewRef,
// this append fails duplicate_review_claim (the ledger's second unique index): re-read the
// ledger and report that winner's outcome (joined: true) instead of erroring or minting twice.
// Deliver is the CALLER's responsibility here, not this helper's: a mint failure that records
// its OWN denial must not notify (see the resumeByPoll call site), while a genuine join must.
async function appendTerminalOutcome(
  deps: WarrantEveDeps, runId: string, requestId: string,
  event: 'warrant.issued' | 'warrant.denied', principal: LedgerEntry['principal'], entryPayload: Record<string, unknown>,
): Promise<Result<{ outcome: TerminalOutcome; joined: boolean }, WarrantError>> {
  const append = await deps.ledger.append({ runId, at: deps.now().toISOString(), event, principal, payload: entryPayload });
  if (!append.error) {
    return ok({ outcome: event === 'warrant.issued' ? 'issued' : 'denied', joined: false });
  }
  if (append.error.code !== 'duplicate_review_claim') {
    return err({ type: 'transient', code: 'ledger_append_error', message: append.error.message });
  }
  const freshAll = await deps.ledger.readAll();
  if (freshAll.error) return err({ type: 'transient', code: 'ledger_read_error', message: freshAll.error.message });
  const freshEntries = freshAll.data.filter(e => e.runId === runId);
  const winnerOutcome = findByRequestId(freshEntries, 'warrant.issued', requestId)
    ? 'issued' as const
    : findByRequestId(freshEntries, 'warrant.denied', requestId) ? 'denied' as const : null;
  // The unique index only rejects when a competing outcome already exists, so this should be
  // unreachable; fail closed rather than guess at an outcome we cannot see.
  if (!winnerOutcome) {
    return err({ type: 'transient', code: 'resume_internal_error',
      message: `duplicate_review_claim on ${event} but no competing outcome found for requestId ${requestId}` });
  }
  return ok({ outcome: winnerOutcome, joined: true });
}

export async function resumeByPoll(
  deps: WarrantEveDeps,
  opts: {
    reviewId: string;
    runId: string;
    deliver: (outcome: 'approved' | 'denied') => Promise<void>;
  },
): Promise<Result<'issued' | 'denied' | 'pending', WarrantError>> {
  try {
    // Step 1: chain-verify via readAll
    const allResult = await deps.ledger.readAll();
    if (allResult.error) {
      return err({ type: 'transient', code: 'ledger_read_error', message: allResult.error.message });
    }
    const cv = verifyChain(allResult.data);
    if (cv.error) return err({ type: 'integrity', code: 'chain_broken', message: cv.error.message });
    const entries = allResult.data.filter(e => e.runId === opts.runId);

    // Step 2: review.submitted is authoritative for requestId/content/principal. Never the
    // park store, never a webhook body.
    const reviewEntry = entries.find(e =>
      e.event === 'review.submitted' && payload(e)['reviewId'] === opts.reviewId,
    );
    if (!reviewEntry) {
      return err({ type: 'validation', code: 'review_not_found',
        message: `No review.submitted for reviewId: ${opts.reviewId}` });
    }
    const rp = payload(reviewEntry);
    // Step 2b: the correlation key must be PRESENT, and this is the first gate rather than a
    // later one. Everything downstream (the step-3 idempotency read, step 4's provenance
    // lookups, the minted warrant) is keyed on this value, so an absent id is not a degraded
    // run, it is a run whose provenance question cannot be asked. `missing_provenance` is the
    // honest code: there is no request to correlate to. See `findByRequestId`.
    const rawRequestId = rp['requestId'];
    if (typeof rawRequestId !== 'string' || rawRequestId === '') {
      return err({
        type: 'validation', code: 'missing_provenance',
        message: `review.submitted for reviewId ${opts.reviewId} carries no requestId`,
      });
    }
    const requestId = rawRequestId;
    // Deliberately uncast. This is a ledger payload value; nothing here
    // has checked it, and `as EmailContent` was a claim this file was in no
    // position to make: a run whose content row is null made it false. It stays
    // `unknown` all the way to `mintHumanWarrant`'s own shape guard, which is the
    // only thing entitled to narrow it.
    const content = rp['content'];
    const principal = reviewEntry.principal;

    // Step 3: idempotency keyed on the CLAIM (review.decided), not on the outcome. A claim
    // whose outcome is already visible returns it. A claim with NO visible outcome (3b,
    // orphaned: a crash between the claim append and the outcome append) falls through to
    // steps 4-9 instead of returning: step 7 skips re-appending the claim, and
    // appendTerminalOutcome above is what makes that safe even under a second, concurrent
    // orphaned-claim resume.
    const claimAlready = entries.some(e => e.event === 'review.decided' && payload(e)['reviewId'] === opts.reviewId);
    if (claimAlready) {
      const outcome = await deriveClaimedOutcome(entries, requestId, opts.deliver, deps);
      if (outcome) return ok(outcome);
    }

    // Step 4: provenance (fail-closed, no silent defaults)
    const requestedEntry = findByRequestId(entries, 'warrant.requested', requestId);
    if (!requestedEntry) {
      return err({ type: 'validation', code: 'missing_provenance',
        message: `No warrant.requested for requestId: ${requestId}` });
    }
    const actionKind = payload(requestedEntry)['actionKind'] as string;
    // Step 4b: the context must be PRESENT, for the same reason step 2b demands the requestId:
    // under this step's own "fail-closed, no silent defaults" heading, this must never fall back
    // to `?? {}`.
    //
    // **An absent context is not a degraded re-evaluation, it is a different one.**
    // `originalContext` is handed to `mintHumanWarrant`, which rebuilds an `ActionRequest` around
    // it and re-runs `evaluate()`. That engine reads context directly: `evaluate.ts:53` takes
    // `request.context['audience']` and returns the FIRST matching stakes rule, where a rule with
    // `match.audience === undefined` matches anything. So substituting `{}` does not lose a field;
    // it makes `audience` undefined, stops the specific rule matching, and falls through to a
    // broader one. `evaluate.ts:36` reads `sentTodayByKind` the same way, so caps stop applying too.
    // Both failure directions are permissive.
    //
    // The result would be a signed warrant attesting a `ruleId` that never governed this action,
    // which is the certificate making a claim the ledger contradicts, and `mintHumanWarrant` only
    // refuses on `deny`, so nothing downstream catches it.
    //
    // Reachability is the same class as `isEmailContent`'s guard: unreachable through this repo's
    // own TypeScript, since `toContext` returns `Record<string, unknown>` and `requestAuthority`
    // always writes it, but `ActionRequestSchema` is **never `.parse()`d in production** (a
    // standing residual), `canonicalJson` drops `undefined` keys before hashing, and a JS consumer
    // or a cast reaches this with no context in the payload at all. A guard whose only defence is
    // that every caller is well-typed is not a guard.
    const rawContext = payload(requestedEntry)['context'];
    if (rawContext === null || typeof rawContext !== 'object' || Array.isArray(rawContext)) {
      return err({
        type: 'validation', code: 'missing_provenance',
        message:
          `warrant.requested for requestId ${requestId} carries no usable context; ` +
          `re-evaluation would match a different rule than the one that required review`,
      });
    }
    const originalContext = rawContext as Record<string, unknown>;

    const evaluatedEntry = findByRequestId(entries, 'policy.evaluated', requestId);
    if (!evaluatedEntry || payload(evaluatedEntry)['path'] !== 'human') {
      return err({ type: 'validation', code: 'missing_provenance',
        message: `No policy.evaluated with path=human for requestId: ${requestId}` });
    }

    // Step 5: the gate is the sole authority on the decision; re-fetched even on
    // the orphaned-claim fall-through. Its typed error propagates UNMODIFIED: re-wrapping every
    // failure as gate_unreachable would erase human_attestation_missing, unrecognized_decision,
    // and unrecognized_status, collapsing "a machine tried to approve this" into "the network
    // was flaky", a lost security signal and a wrong retry hint, since a caller retrying an
    // attestation failure would retry forever. A genuine transport failure is the Gate
    // implementation's job to label gate_unreachable itself.
    const decResult = await deps.gate.fetchDecision(opts.reviewId);
    if (decResult.error) return err(decResult.error);
    if ('pending' in decResult.data) return ok('pending');
    const decision = decResult.data;

    // Step 5b: the human attestation is required, and checked at the boundary rather than
    // trusted from the type. Gate is exported for third parties to implement, so
    // `decidedBy: string` is a compile-time promise a JS consumer or a loose cast does not
    // keep. It fails SILENTLY without this: canonicalJson drops undefined keys before
    // hashing, so review.decided hashes clean, verifyChain passes, and the certificate
    // attests a human review that names no human. Ahead of the step-7 claim on purpose, so
    // an unattributable decision leaves no trace of having been accepted.
    if (typeof decision.decidedBy !== 'string' || decision.decidedBy.trim() === '') {
      return err({ type: 'validation', code: 'human_attestation_missing',
        message: 'Gate returned a decision with no decidedBy' });
    }

    // Step 6: whitelist check
    if (decision.decision === 'edited' && decision.editedContent === undefined) {
      return err({ type: 'validation', code: 'edited_no_content',
        message: 'Gate returned edited decision with no editedContent' });
    }

    // Step 6b: park cross-check. Ledger is authoritative; the park record is advisory eve
    // plumbing. Absent is NOT an error (resumeByPoll is also driven directly by tests with no
    // park entry); a mismatched callId is.
    const parkResult = await deps.parkStore.get(opts.reviewId);
    if (parkResult.error) {
      return err({ type: 'transient', code: 'park_read_error', message: parkResult.error.message });
    }
    if (parkResult.data && parkResult.data.callId !== requestId) {
      return err({ type: 'integrity', code: 'park_correlation_mismatch',
        message: `Park record callId (${parkResult.data.callId}) does not match ledger requestId (${requestId})` });
    }

    // Step 7: CLAIM before minting or denying, on both branches; skipped when the claim
    // already exists (the step-3b fall-through). A collision here means a concurrent resume
    // won the claim first: re-derive its outcome and return it rather than erroring.
    if (!claimAlready) {
      const claimAppend = await deps.ledger.append({
        runId: opts.runId, at: deps.now().toISOString(), event: 'review.decided',
        principal, payload: { requestId, reviewId: opts.reviewId, decision: decision.decision, decidedBy: decision.decidedBy },
      });
      if (claimAppend.error) {
        if (claimAppend.error.code === 'duplicate_review_claim') {
          const freshAll = await deps.ledger.readAll();
          if (freshAll.error) return err({ type: 'transient', code: 'ledger_read_error', message: freshAll.error.message });
          const freshEntries = freshAll.data.filter(e => e.runId === opts.runId);
          const outcome = await deriveClaimedOutcome(freshEntries, requestId, opts.deliver, deps);
          // A live winner (outcome visible) is reported directly. A still-in-flight winner
          // (outcome not yet visible) reports pending rather than inventing a result: nothing
          // about THIS call completes the winner's own claim.
          return outcome ? ok(outcome) : ok('pending');
        }
        return err({ type: 'transient', code: 'ledger_append_error', message: claimAppend.error.message });
      }
    }

    // Step 8: reject branch
    if (decision.decision === 'rejected') {
      const denyResult = await appendTerminalOutcome(
        deps, opts.runId, requestId, 'warrant.denied', principal,
        { requestId, reason: 'human_rejected', reviewRef: opts.reviewId },
      );
      if (denyResult.error) return err(denyResult.error);
      await tryDeliver(opts.deliver, denyResult.data.outcome === 'issued' ? 'approved' : 'denied', deps, 'mint-refused:joined');
      return ok(denyResult.data.outcome);
    }

    // Step 9: approve/edit, mint with re-policy-check on the FINAL content
    const mintResult = await mintHumanWarrant({
      deps, runId: opts.runId, reviewId: opts.reviewId,
      requestId, content, principal, decision, actionKind, originalContext,
    });
    if (mintResult.error) {
      const denyResult = await appendTerminalOutcome(
        deps, opts.runId, requestId, 'warrant.denied', principal,
        { requestId, reason: mintResult.error.code, reviewRef: opts.reviewId },
      );
      if (denyResult.error) return err(denyResult.error);
      if (denyResult.data.joined) {
        // A concurrent resume already recorded its OWN outcome for this reviewRef before our
        // denial landed: report that instead of this call's own mint failure, and deliver it
        // (this call never has).
        await tryDeliver(opts.deliver, denyResult.data.outcome === 'issued' ? 'approved' : 'denied', deps, 'denied');
        return ok(denyResult.data.outcome);
      }
      // Our own denial was recorded. Surface the specific mint-failure reason; no delivery:
      // this mirrors the pre-existing contract (a denial from a failed re-policy-check was
      // never a delivered outcome).
      return mintResult;
    }
    const { warrant: w, authorized } = mintResult.data;

    const issuedResult = await appendTerminalOutcome(
      deps, opts.runId, requestId, 'warrant.issued', principal,
      { requestId, warrantId: w.id, warrant: w, authorized, reviewRef: opts.reviewId, decidedBy: decision.decidedBy },
    );
    if (issuedResult.error) return err(issuedResult.error);
    await tryDeliver(opts.deliver, issuedResult.data.outcome === 'issued' ? 'approved' : 'denied', deps, 'issued');
    return ok(issuedResult.data.outcome);
  } catch (e) {
    return err({
      type: 'transient', code: 'resume_internal_error',
      message: e instanceof Error ? e.message : 'resumeByPoll: unexpected error',
    });
  }
}
