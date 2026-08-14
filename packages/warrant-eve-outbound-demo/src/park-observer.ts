// park-observer.ts: eve-free (types-only) mapping from eve's input.requested stream
// events onto ParkStore writes. Never imports from `eve`: event shapes are structural
// copies of eve's InputRequestedStreamEvent / SessionWaitingStreamEvent etc., verified
// against the eve SDK's own .d.ts, so this module is unit-testable with mock events
// and no eve runtime.
//
// Fail closed: if a park write cannot be correlated (no matching review.submitted), or
// the ledger read fails, or the source stream errors mid-read, this module writes NO
// park record and does not throw. The run simply stays parked; the later webhook lookup
// 404s. The action never fires without a park record, which is the safe direction and
// never the other way around.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { Ledger } from '@idriszade/warrant-ledger';
import type { ParkStore } from '@idriszade/warrant-eve';
import type { ReadableStreamReadResult } from 'node:stream/web';

export interface ParkObserverEvent {
  type: string;
  data?: { requests?: readonly { requestId: string; action: { callId: string } }[] };
}

export interface ParkObserverOpts {
  ledger: Ledger;
  parkStore: ParkStore;
  runId: string;
  continuationToken: string;
  now: () => Date;
}

const TERMINAL_TYPES = new Set(['session.waiting', 'session.completed', 'session.failed']);

export async function handleParkObserverEvent(
  event: ParkObserverEvent,
  opts: ParkObserverOpts,
): Promise<Result<'stop' | 'continue', WarrantError>> {
  try {
    if (TERMINAL_TYPES.has(event.type)) return ok('stop');
    if (event.type !== 'input.requested') return ok('continue');

    const readResult = await opts.ledger.readRun(opts.runId);
    if (readResult.error) return err(readResult.error);

    for (const req of event.data?.requests ?? []) {
      // The needle must be present before it can correlate. `ParkObserverEvent` is a hand-declared
      // structural copy of eve's shape (see the header: this module never imports from eve) and the
      // stream JSON is parsed with no schema, so `req.action.callId` is `unknown` in practice
      // however it is typed: the refutation that makes this construct safe in `warrant-eve` does
      // NOT reach here.
      //
      // **Why this is not merely tidiness: it is what keeps `resumeByPoll`'s cross-check real.**
      // The `callId` written at `:59` is what `resume.ts` re-checks the ledger against. An id-less
      // park write makes that comparison `undefined !== undefined` → false → pass, so the defect
      // at this line silently disarms the mitigation for the same defect one package over.
      const callId = req.action?.callId;
      if (typeof callId !== 'string' || callId === '') continue;

      const reviewEntry = readResult.data.find(e => {
        if (e.event !== 'review.submitted') return false;
        if (typeof e.payload !== 'object' || e.payload === null) return false;
        const candidate = (e.payload as Record<string, unknown>)['requestId'];
        return typeof candidate === 'string' && candidate === callId;
      });
      if (!reviewEntry) continue; // no matching review.submitted: do not park, do not throw

      // Same rule, the neighbour of the line above: an absent reviewId written into the park
      // record is a park nothing can later find, and `as string` claimed a shape nobody checked.
      const rawReviewId = (reviewEntry.payload as Record<string, unknown>)['reviewId'];
      if (typeof rawReviewId !== 'string' || rawReviewId === '') continue;
      const reviewId = rawReviewId;
      const putResult = await opts.parkStore.put({
        reviewId,
        runId: opts.runId,
        callId,                          // ADVISORY: cross-checked against the ledger in resumeByPoll.
                                         // Guaranteed a non-empty string by the guard above, which
                                         // is what makes that cross-check able to fail.
        eveRequestId: req.requestId,     // eve's InputRequest.requestId: distinct from callId.
        continuationToken: opts.continuationToken,
        parkedAt: opts.now().toISOString(),
      });
      if (putResult.error) return err(putResult.error);
    }
    return ok('continue');
  } catch (e) {
    // Defense in depth beyond the Result-typed paths above: no public function in this
    // module may throw (global constraints), so any unexpected exception is caught here
    // and reported as a typed err rather than propagating.
    return err({
      type: 'transient', code: 'park_observer_internal_error',
      message: e instanceof Error ? e.message : 'handleParkObserverEvent: unexpected error',
    });
  }
}

export async function consumeParkObserverStream(
  stream: ReadableStream<ParkObserverEvent>,
  opts: ParkObserverOpts,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      let step: ReadableStreamReadResult<ParkObserverEvent>;
      try {
        step = await reader.read();
      } catch {
        // The stream errored mid-consumption. This runs inside `waitUntil`, so an
        // unguarded rejection here would surface as an unhandled rejection outside the
        // request/response cycle. Stop cleanly instead: fail closed, no further park
        // records are written after this point.
        return;
      }
      if (step.done) return;
      const result = await handleParkObserverEvent(step.value, opts);
      if (result.error || result.data === 'stop') return;
    }
  } finally {
    reader.releaseLock();
  }
}
