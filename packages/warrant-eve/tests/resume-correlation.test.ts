// tests/resume-correlation.test.ts: an absent `requestId` must never correlate.
//
// **The case this file exists for minted a fully signed warrant.** `findByRequestId` compared
// `payload['requestId'] === requestId` with the needle reached through an `as string` cast off a
// ledger payload, so it could be `undefined`, and `undefined === undefined` is true. A
// `review.submitted` carrying no `requestId` matched a `warrant.requested` carrying no
// `requestId`, step 4's provenance check passed VACUOUSLY, and the run reached `warrant.issued`
// with `verifyChain` passing.
//
// The measured three-case split before the fix:
//   only the review lacks it  -> missing_provenance   (fail-closed, correct)
//   actionKind missing        -> policy_denied_on_final (fail-closed, correct)
//   BOTH lack it              -> ISSUED
//
// Typing the needle differently would not have fixed it: the missing thing is a PRESENCE check,
// not a shape claim. That is what these tests pin.
//
// Not reachable through warrant's own writers: `requestAuthority` always writes `requestId: id`
// (`warrant-authorize/src/request-authority.ts:121`), so every ledger here is hand-built, which
// is exactly the threat model: `verifyChain` proves append ORDER, not payload COMPLETENESS.
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { resumeByPoll } from '../src/index.js';
import { SESSION_ID, PRINCIPAL, makeDeps } from './fixtures.js';

const approveAny: Gate = {
  submit: async (_r: ReviewRequest) => ok({ reviewId: 'r-0' }),
  fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
    ok({ reviewId: id, decision: 'approved' as const, decidedBy: 'reviewer:erin' }),
};

const CONTENT = { to: 'ok@example.com', subject: 'Intro', body: 'Hello' };

async function seed(rows: readonly (readonly [string, Record<string, unknown>])[]): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  for (const [event, payload] of rows) {
    const r = await ledger.append({
      runId: SESSION_ID, at: '2026-07-31T10:00:00.000Z',
      event: event as never, principal: PRINCIPAL, payload,
    });
    expect(r.error).toBeNull();
  }
  return ledger;
}

const events = async (l: MemoryLedger): Promise<readonly string[]> =>
  (await l.readRun(SESSION_ID)).data!.map(e => e.event);

describe('resumeByPoll: an absent requestId cannot correlate', () => {
  it('THE CASE THIS FILE EXISTS FOR: both sides lack requestId and NOTHING is minted', async () => {
    const ledger = await seed([
      // Every row well-formed except that none names a requestId. The chain verifies.
      ['warrant.requested', { actionKind: 'send_email', target: 'p@example.com', context: {} }],
      ['policy.evaluated', { ruleId: 'cold-email', path: 'human' }],
      ['review.submitted', { reviewId: 'r-0', content: CONTENT }],
    ]);

    const result = await resumeByPoll(makeDeps({ ledger, gate: approveAny }), {
      reviewId: 'r-0', runId: SESSION_ID, deliver: vi.fn(),
    });

    expect(result.data).toBeNull();
    expect(result.error!.code).toBe('missing_provenance');

    // The assertion that actually matters, and the one a code-shaped check would miss: no
    // authority was created. Before the fix this list ended in warrant.issued.
    const seen = await events(ledger);
    expect(seen).not.toContain('warrant.issued');
    expect(seen).not.toContain('review.decided');
    expect(seen).toEqual(['warrant.requested', 'policy.evaluated', 'review.submitted']);
  });

  it('an empty-string requestId is absent, not a value', async () => {
    const ledger = await seed([
      ['warrant.requested', { requestId: '', actionKind: 'send_email', target: 'p@example.com', context: {} }],
      ['policy.evaluated', { requestId: '', ruleId: 'cold-email', path: 'human' }],
      ['review.submitted', { reviewId: 'r-0', requestId: '', content: CONTENT }],
    ]);

    const result = await resumeByPoll(makeDeps({ ledger, gate: approveAny }), {
      reviewId: 'r-0', runId: SESSION_ID, deliver: vi.fn(),
    });

    expect(result.error!.code).toBe('missing_provenance');
    expect(await events(ledger)).not.toContain('warrant.issued');
  });

  it('a non-string requestId does not coerce into a match', async () => {
    const ledger = await seed([
      ['warrant.requested', { requestId: 1, actionKind: 'send_email', target: 'p@example.com', context: {} }],
      ['policy.evaluated', { requestId: 1, ruleId: 'cold-email', path: 'human' }],
      ['review.submitted', { reviewId: 'r-0', requestId: 1, content: CONTENT }],
    ]);

    const result = await resumeByPoll(makeDeps({ ledger, gate: approveAny }), {
      reviewId: 'r-0', runId: SESSION_ID, deliver: vi.fn(),
    });

    expect(result.error!.code).toBe('missing_provenance');
    expect(await events(ledger)).not.toContain('warrant.issued');
  });

  it('NOT VACUOUS: the identical ledger WITH a requestId still refuses only for the right reason', async () => {
    // Same three rows, correlated properly. This must NOT fail with missing_provenance, otherwise
    // the tests above would pass on a function that refuses everything, which proves nothing.
    const ledger = await seed([
      ['warrant.requested', { requestId: 'call-1', actionKind: 'send_email', target: 'p@example.com', context: {} }],
      ['policy.evaluated', { requestId: 'call-1', ruleId: 'cold-email', path: 'human' }],
      ['review.submitted', { reviewId: 'r-0', requestId: 'call-1', content: CONTENT }],
    ]);

    const result = await resumeByPoll(makeDeps({ ledger, gate: approveAny }), {
      reviewId: 'r-0', runId: SESSION_ID, deliver: vi.fn(),
    });

    // It gets past correlation: whatever it does next, it is not "no provenance".
    expect(result.error?.code).not.toBe('missing_provenance');
  });

  it('one side present and one absent stays fail-closed, as it already did', async () => {
    const ledger = await seed([
      ['warrant.requested', { requestId: 'call-1', actionKind: 'send_email', target: 'p@example.com', context: {} }],
      ['policy.evaluated', { requestId: 'call-1', ruleId: 'cold-email', path: 'human' }],
      ['review.submitted', { reviewId: 'r-0', content: CONTENT }],
    ]);

    const result = await resumeByPoll(makeDeps({ ledger, gate: approveAny }), {
      reviewId: 'r-0', runId: SESSION_ID, deliver: vi.fn(),
    });

    expect(result.error!.code).toBe('missing_provenance');
    expect(await events(ledger)).not.toContain('warrant.issued');
  });
});
