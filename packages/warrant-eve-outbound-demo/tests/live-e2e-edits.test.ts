/**
 * live-e2e-edits.test.ts: sibling to live-e2e.test.ts (Task 12), proving the APPROVE-WITH-EDITS
 * path specifically, because it is the difference between a certificate that is true and one
 * that merely looks true. Gatewerk's human review UI never sends decision:'edited': the inbox
 * always sends decision:'approved' carrying edited_payload (warrant-gatewerk/src/decision.ts,
 * verified against apps/web/src/pages/inbox/use-inbox-keyboard-shortcuts.ts). A webhook handler
 * or gate that only special-cased decision:'edited' would silently mint over the ORIGINAL params
 * while the certificate attested a human approved: the agent would send exactly the content the
 * human corrected away.
 * This drives the same real code paths as live-e2e.test.ts (real withWarrant approval, real
 * park observer, real signed webhook, real GatewerkGate + mapReviewDecision, real resumeByPoll,
 * real execute), differing only in the fixture: the decision carries edited_payload with a
 * corrected recipient. The assertion is that the outbox entry carries the CORRECTED recipient,
 * never the original. No certificate export here: that machinery is proven once in
 * live-e2e.test.ts; this file's whole point is the edit-preservation property.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { MemoryParkStore } from '@idriszade/warrant-eve';
import { buildDeps, buildSendEmailTool } from '../src/build.js';
import type { DemoInput, EmailContent } from '../src/build.js';
import { handleGatewerkWebhook } from '../src/webhook-handler.js';
import { handleParkObserverEvent } from '../src/park-observer.js';
import type { ParkObserverEvent } from '../src/park-observer.js';

const RUN_ID = 'live-e2e-edits-run-1';
const WEBHOOK_SECRET = 'live-e2e-edits-webhook-secret';
const NOW = () => new Date('2026-07-27T09:00:00.000Z');
const ORIGINAL_TO = 'typo-prospct@corp.com';
const CORRECTED_TO = 'prospect@corp.com';

// decision:'approved' + edited_payload, NEVER decision:'edited': this is the exact shape
// Gatewerk's human inbox emits for an approve-with-corrections. last_action_by:'reviewer:...'
// is the human-attestation allowlist entry required to mint at all (design spec 2.2/7.2).
const SUBMIT_FIXTURE = { id: 'review-live-edit-001' };
const DECISION_FIXTURE = {
  id: 'review-live-edit-001',
  status: 'decided',
  decision: 'approved',
  decided_by: 'alice@corp.example',
  last_action_by: 'reviewer:alice@corp.example',
  edited_payload: { to: CORRECTED_TO, subject: 'Intro', body: 'Hello' },
};

function makeFixtureFetch(): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    const body = calls === 1 ? SUBMIT_FIXTURE : DECISION_FIXTURE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function signStandardWebhook(rawBody: string, secret: string, now: () => Date): Headers {
  const id = 'live-edit-msg-1';
  const ts = Math.floor(now().getTime() / 1000).toString();
  const sig = createHmac('sha256', secret).update(`${id}\n${ts}\n${rawBody}`).digest('base64');
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` });
}

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

function makeToolCtx(callId: string): ToolContext {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId,
    toolName: 'send_email',
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
    getToken: async () => { throw new Error('n/a'); },
    requireAuth: () => { throw new Error('n/a') as never; },
  } satisfies ToolContext;
}

describe('Milestone B approve-with-edits proof (Task 12 sibling)', () => {
  it('human corrects the recipient in Gatewerk; execute ships the CORRECTED recipient, never the original', async () => {
    const outbox: EmailContent[] = [];
    const deps = buildDeps({
      ledger: new MemoryLedger(),
      gate: new GatewerkGate({
        baseUrl: 'https://gatewerk.example.test',
        apiKey: 'test-key',
        callbackUrl: 'https://agent.example.test/warrant/v1/gatewerk/review',
        templateSlug: 'warrant-outbound-email',
        fetchImpl: makeFixtureFetch(),
      }),
      parkStore: new MemoryParkStore(),
      now: NOW,
      newId: (() => { let t = 0; return () => `edit-id-${++t}`; })(),
    });
    const tool = buildSendEmailTool(deps, outbox);

    const input: DemoInput = { to: ORIGINAL_TO, subject: 'Intro', body: 'Hello', audience: 'cold' };
    const approval = await tool.approval!(makeApprovalCtx('call-1', input));
    expect(approval).toBe('user-approval');

    const run = await deps.ledger.readRun(RUN_ID);
    const reviewEntry = run.data!.find(e => e.event === 'review.submitted')!;
    const requestId = (reviewEntry.payload as Record<string, unknown>)['requestId'] as string;
    const reviewId = (reviewEntry.payload as Record<string, unknown>)['reviewId'] as string;

    const parkEvent: ParkObserverEvent = {
      type: 'input.requested',
      data: { requests: [{ requestId: 'eve-req-1', action: { callId: requestId } }] },
    };
    const observed = await handleParkObserverEvent(parkEvent, {
      ledger: deps.ledger, parkStore: deps.parkStore, runId: RUN_ID,
      continuationToken: 'cont-tok-1', now: NOW,
    });
    expect(observed.data).toBe('continue');

    const rawBody = JSON.stringify({ type: 'review.decided', review_id: reviewId });
    const headers = signStandardWebhook(rawBody, WEBHOOK_SECRET, NOW);
    const outcome = await handleGatewerkWebhook(deps, {
      rawBody, headers, secret: WEBHOOK_SECRET, deliver: async () => {},
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body['outcome']).toBe('issued');

    // The minted warrant must carry the CORRECTED recipient as `authorized`, not the original.
    const afterResume = await deps.ledger.readRun(RUN_ID);
    const issuedEntry = afterResume.data!.find(e => e.event === 'warrant.issued')!;
    const issuedPayload = issuedEntry.payload as Record<string, unknown>;
    expect((issuedPayload['authorized'] as EmailContent).to).toBe(CORRECTED_TO);
    expect(issuedPayload['decidedBy']).toBe('alice@corp.example');

    // buildExecute's step 3 reads `authorized` off the warrant.issued payload, never
    // binding.toParams(input): this is the mechanism that makes the corrected recipient the one
    // that actually ships, not a re-derivation from the agent's original (uncorrected) call.
    const out = await tool.execute(input, makeToolCtx('call-1'));
    expect(out.messageId).toMatch(/^sent-/);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(CORRECTED_TO);
    expect(outbox[0]!.to).not.toBe(ORIGINAL_TO);
  });
});
