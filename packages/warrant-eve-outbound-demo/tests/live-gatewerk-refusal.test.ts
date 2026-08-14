/**
 * live-gatewerk-refusal.test.ts: run the rehearsal headlessly to its refusal, a fail-closed path
 * proved against a REAL running Gatewerk over real HTTP. No Postgres, no webhook, no human, no
 * email.
 *
 * Every existing guard test feeds `mapReviewDecision` a hand-built object
 * (`warrant-gatewerk/tests/decision.test.ts`), or fakes the network with an injected `fetchImpl`
 * (`tests/live-e2e.test.ts`'s `makeFixtureFetch`). Nothing before this file has exercised the
 * human-attestation guard against a real HTTP response body from a running Gatewerk instance.
 *
 * The flow: the REAL withWarrant approval parks on the real policy `human` verdict, and in doing
 * so calls the REAL `GatewerkGate#submit` against the live eval instance: a review is genuinely
 * created in Gatewerk. The review is then decided over the Gatewerk API using the SAME api-key
 * credential GatewerkGate itself authenticates with (never a reviewer session), via the canonical
 * `POST /api/v1/reviews/:id/action` route (`action_id: 'approve'`), see
 * gatewerk/apps/api/src/routes/reviews/action.ts:103-105 (api-key auth -> actor
 * {kind:'agent', id: apiKeyPrefix}) and services/reviews/actions.ts:217 (decided_by = actor.id,
 * the raw id, no human marker) plus :36/:188 for `last_action_by` gaining the `agent:` prefix.
 * `email-review`'s `approve` action id maps to `decision_value:'approved'`
 * (gatewerk/packages/shared/src/api/schemas/templates.ts DEFAULT_ACTION_PRESETS).
 *
 * The REAL `resumeByPoll` is then driven directly (no webhook signing needed: resumeByPoll only
 * needs `{ reviewId, runId, deliver }` and re-fetches the decision itself, per
 * `tests/../warrant-eve/tests/resume.test.ts`'s own direct-call pattern). It re-fetches the
 * decision via the REAL `GatewerkGate#fetchDecision`, and `decision.ts`'s `mapReviewDecision`
 * gates on `last_action_by` (an allowlist requiring a `reviewer:` prefix), not on `decided_by`:
 * an agent-decided review carries `agent:<apiKeyPrefix>` no matter how the caller dresses up
 * `decided_by`, so this must refuse with `human_attestation_missing` and mint nothing. **A
 * passing run here is a refusal.**
 *
 * A manual probe against the same live instance recorded this same refusal; this file makes that
 * probe permanent as a test.
 *
 * Gated exactly like warrant-eve/tests/runtime-grants-live.test.ts: skips cleanly, no failure, no
 * hang, when the live-Gatewerk credential is absent. Source `.env.rehearsal` first:
 *   set -a; . ./.env.rehearsal; set +a
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { MemoryParkStore, resumeByPoll } from '@idriszade/warrant-eve';
import { buildDeps, buildSendEmailTool } from '../src/build.js';
import type { DemoInput, EmailContent } from '../src/build.js';
import { handleParkObserverEvent } from '../src/park-observer.js';
import type { ParkObserverEvent } from '../src/park-observer.js';

/**
 * **Unique per run, and this is load-bearing rather than hygiene.** `GatewerkGate#submit` sends
 * `idempotency_key: r.requestId`, and `requestId` is the approval context's `callId`. A constant
 * `'call-1'` therefore reuses one idempotency key against a real server forever: the first run
 * creates a review and decides it, and every run after that gets
 * `409 idempotency_key_terminal_conflict`: *"a review with this idempotency_key already exists
 * in a terminal state."*
 *
 * That failure is worth naming because of how it presents. `approval.ts:72` maps **every**
 * `submit` error to `reason: 'gate_unreachable'`, so a 409 caused entirely by this test's own
 * constant arrives looking like the Gatewerk instance being down, and the run dies at step 1
 * having never reached the guard it exists to prove. The same idiom as
 * `warrant-eve/tests/runtime-grants-live.test.ts`'s schema suffix, for the same reason: a live
 * test that mutates real server state must not collide with its own history.
 */
const SUFFIX = `${process.pid}_${Date.now()}`;
const RUN_ID = `live-gatewerk-refusal-run-${SUFFIX}`;
const CALL_ID = `call-${SUFFIX}`;
const NOW = () => new Date('2026-07-31T09:00:00.000Z');

const GATEWERK_BASE_URL = process.env['GATEWERK_BASE_URL'];
const GATEWERK_API_KEY = process.env['GATEWERK_API_KEY'];
const GATEWERK_TEMPLATE_SLUG = process.env['GATEWERK_TEMPLATE_SLUG'] ?? 'email-review';

function makeApprovalCtx(callId: string, toolInput: DemoInput): ApprovalContext<DemoInput> {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId,
    toolName: 'send_email',
    toolInput,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<DemoInput>;
}

describe.skipIf(!GATEWERK_API_KEY || !GATEWERK_BASE_URL)(
  'live Gatewerk refusal: fail-closed path proved against a real running Gatewerk (STATUS next action 2)',
  () => {
    it('an API-key-decided review is refused by resumeByPoll: no warrant.issued, empty outbox', async () => {
      const outbox: EmailContent[] = [];
      const deps = buildDeps({
        ledger: new MemoryLedger(),
        gate: new GatewerkGate({
          baseUrl: GATEWERK_BASE_URL!,
          apiKey: GATEWERK_API_KEY!,
          // Gatewerk's own submit-side SSRF guard (apps/api/src/lib/ssrf.ts) requires a
          // resolvable, non-private hostname or the create call itself 400s: an
          // unresolvable *.test/*.example placeholder (as live-e2e.test.ts's fixture-fetch
          // version uses) fails closed here against the real API. This run resumes by direct
          // poll, never by webhook delivery, so Gatewerk's best-effort callback firing (or not)
          // to a real, unlistening address is otherwise inert.
          callbackUrl: 'https://example.com/warrant/v1/gatewerk/review',
          templateSlug: GATEWERK_TEMPLATE_SLUG,
          // No fetchImpl: this is the real global fetch, hitting the real Gatewerk eval API.
        }),
        parkStore: new MemoryParkStore(),
        now: NOW,
        newId: (() => { let t = 0; return () => `live-refusal-id-${++t}`; })(),
      });
      const tool = buildSendEmailTool(deps, outbox);

      // ── Step 1: the REAL withWarrant approval parks on a real policy `human` verdict, and in
      // doing so calls the REAL GatewerkGate#submit: a review now genuinely exists in Gatewerk ─
      const input: DemoInput = { to: 'prospect@corp.com', subject: 'Intro', body: 'Hello', audience: 'cold' };
      const approval = await tool.approval!(makeApprovalCtx(CALL_ID, input));
      expect(approval).toBe('user-approval');

      const run = await deps.ledger.readRun(RUN_ID);
      const reviewEntry = run.data!.find(e => e.event === 'review.submitted')!;
      const requestId = (reviewEntry.payload as Record<string, unknown>)['requestId'] as string;
      const reviewId = (reviewEntry.payload as Record<string, unknown>)['reviewId'] as string;
      expect(reviewId).toBeTruthy();
      // Surfaced so the review can be cleaned up from the eval Gatewerk DB afterwards.
      // eslint-disable-next-line no-console
      console.log(`[live-gatewerk-refusal] created review ${reviewId} in Gatewerk (${GATEWERK_BASE_URL})`);

      // ── Step 2: the REAL park observer records the park from a real-shaped input.requested ──
      const parkEvent: ParkObserverEvent = {
        type: 'input.requested',
        data: { requests: [{ requestId: 'eve-req-1', action: { callId: requestId } }] },
      };
      const observed = await handleParkObserverEvent(parkEvent, {
        ledger: deps.ledger, parkStore: deps.parkStore, runId: RUN_ID,
        continuationToken: 'cont-tok-1', now: NOW,
      });
      expect(observed.error).toBeNull();
      expect(observed.data).toBe('continue');

      // ── Step 3: decide the review over the REAL Gatewerk API, using the SAME api-key
      // credential GatewerkGate itself authenticates with, never a reviewer session. This is
      // the canonical POST /:id/action route; `approve` is email-review's built-in decision
      // preset (decision_value:'approved'). An api-key actor writes decided_by:<apiKeyPrefix>
      // and last_action_by:'agent:<apiKeyPrefix>', no human marker anywhere on the row.
      const decideRes = await fetch(`${GATEWERK_BASE_URL}/api/v1/reviews/${reviewId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWERK_API_KEY}` },
        body: JSON.stringify({ action_id: 'approve' }),
      });
      const decideBody = await decideRes.json() as { status?: string; decision?: string; last_action_by?: string };
      expect(decideRes.ok).toBe(true);
      expect(decideBody.status).toBe('decided');
      // Sanity check on the live shape itself, independent of what resumeByPoll does with it:
      // an api-key decision must never come back carrying a 'reviewer:' actor.
      expect(decideBody.last_action_by?.startsWith('reviewer:')).toBe(false);

      // ── Step 4: the REAL resumeByPoll, driven directly (no webhook needed: it re-fetches the
      // decision itself via GatewerkGate#fetchDecision) ───────────────────────────────────────
      const delivered: Array<'approved' | 'denied'> = [];
      const result = await resumeByPoll(deps, {
        reviewId, runId: RUN_ID,
        deliver: async (o) => { delivered.push(o); },
      });

      // ── Step 5: the passing assertion is a REFUSAL ──────────────────────────────────────────
      expect(result.error).not.toBeNull();
      expect(result.error?.code).toBe('human_attestation_missing');
      expect(delivered).toEqual([]);

      const all = await deps.ledger.readAll();
      const issuedForRun = all.data!.filter(e => e.runId === RUN_ID && e.event === 'warrant.issued');
      expect(issuedForRun).toEqual([]);

      expect(outbox).toEqual([]);
    }, 30_000);
  },
);
