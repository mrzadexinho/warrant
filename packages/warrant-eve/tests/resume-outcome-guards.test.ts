// Guards in src/resume.ts around reading the run and reporting its outcome, which a
// mutation sweep found uncovered: deleting each one left warrant-eve and
// warrant-eve-outbound-demo green.
//
// The concurrency guards here are the ones that decide what a caller is TOLD happened.
// resumeByPoll's callers act on that answer, so a guard that lets it invent 'issued'
// for a run it cannot see the outcome of is the same defect class as a certificate
// asserting an approval that never happened.
//
// Each test was checked by re-deleting its guard and confirming this test then fails,
// with the deletion diffed to prove it applied.
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { resumeByPoll } from '../src/index.js';
import { SESSION_ID, makeDeps, seedReview } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

const EMAIL: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
const DECIDED_BY = 'reviewer:erin';
const PRINCIPAL = { kind: 'agent' as const, id: 'agent-outbound' };

function approveGate(): Gate {
  return {
    submit: async (_r: ReviewRequest) => ok({ reviewId: 'r-0' }),
    fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
      ok({ reviewId: id, decision: 'approved' as const, decidedBy: DECIDED_BY }),
  };
}

/** A gate whose edit lands on a protected audience, so mintHumanWarrant refuses. */
function govEditGate(): Gate {
  return {
    submit: async (_r: ReviewRequest) => ok({ reviewId: 'r-0' }),
    fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
      ok({
        reviewId: id, decision: 'edited' as const, decidedBy: DECIDED_BY,
        editedContent: { subject: 'Hi', body: 'Body', to: 'ceo@treasury.gov' },
      }),
  };
}

/** Wraps a real MemoryLedger so a chosen event's append fails with a chosen code. */
function failAppendOf(base: MemoryLedger, event: LedgerEntry['event'], code: string): Ledger {
  return {
    append: async (i: LedgerAppendInput) =>
      i.event === event
        ? err({ type: 'transient' as const, code, message: `stub: ${code} on ${event}` })
        : base.append(i),
    readRun: (id: string) => base.readRun(id),
    readAll: () => base.readAll(),
  };
}

async function eventsOf(base: MemoryLedger): Promise<string[]> {
  return (await base.readRun(SESSION_ID)).data!.map((e) => e.event);
}

describe('resumeByPoll reports what it can see, and refuses to guess at the rest', () => {
  it('a ledger that cannot be read is a read error, not a chain failure', async () => {
    // Without the guard, `allResult.data` is null and verifyChain is handed it. The
    // caller then gets chain_broken (integrity, do not retry) for what is actually a
    // transient read failure, and would give up on a run that is perfectly intact.
    const down: Ledger = {
      append: async (_i: LedgerAppendInput) => err({ type: 'transient', code: 'db_down', message: 'no' }),
      readRun: async (_id: string) => err({ type: 'transient', code: 'db_down', message: 'no' }),
      readAll: async () => err({ type: 'transient', code: 'db_down', message: 'no' }),
    };
    const deps = makeDeps({ ledger: down, gate: approveGate() });

    const r = await resumeByPoll(deps, { reviewId: 'anything', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('ledger_read_error');
    expect(r.error?.type).toBe('transient');
  });

  it('an unknown reviewId is review_not_found, not a provenance failure', async () => {
    // Deleting the guard does not open a hole, because the empty payload falls through
    // to the provenance check one step later. What it destroys is the diagnosis: every
    // unknown review would report missing_provenance, pointing an operator at the
    // ledger's warrant.requested rows for a review that was never submitted at all.
    const deps = makeDeps({ gate: approveGate() });
    await seedReview(deps, EMAIL);

    const r = await resumeByPoll(deps, { reviewId: 'never-submitted', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('review_not_found');
    expect(r.error?.message).toContain('never-submitted');
  });

  it('a run with no policy.evaluated at all is refused, not just one routed elsewhere', async () => {
    // The provenance check is `!evaluatedEntry || path !== 'human'`. The second half was
    // covered (a request policy routed to deny); the first was not, so nothing held the
    // case of a run carrying a review and a request but no record that policy ever ran.
    // That is the shape a partially-written or hand-assembled ledger has, and it is the
    // one where "a human approved it" would be the ONLY thing the certificate could say.
    const ledger = new MemoryLedger();
    const at = '2026-07-18T10:00:00.000Z';
    for (const [event, payload] of [
      ['warrant.requested', { requestId: 'call-1', actionKind: 'send_email', target: EMAIL.to, context: { audience: 'cold' } }],
      ['review.submitted', { requestId: 'call-1', reviewId: 'no-eval-0', content: EMAIL }],
    ] as const) {
      expect((await ledger.append({ runId: SESSION_ID, at, event, principal: PRINCIPAL, payload })).error).toBeNull();
    }
    const deps = makeDeps({ ledger, gate: approveGate() });

    const r = await resumeByPoll(deps, { reviewId: 'no-eval-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('missing_provenance');
    expect(await eventsOf(ledger)).not.toContain('warrant.issued');
  });

  it('a terminal run is answered from the ledger without re-consulting the gate', async () => {
    // The idempotency short-circuit does not change the ANSWER when deleted, because
    // the terminal-outcome unique index catches the second mint and joins the winner.
    // What it changes is that every repeat poll re-fetches the decision and mints a
    // whole second warrant to throw away. That is the property worth pinning: once an
    // outcome is in the ledger, the ledger is authoritative and the gate is not asked
    // again. Counting gate calls is the only way to see it.
    const fetchDecision = vi.fn(
      async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: id, decision: 'approved' as const, decidedBy: DECIDED_BY }),
    );
    const gate: Gate = { submit: async (_r: ReviewRequest) => ok({ reviewId: 'r-0' }), fetchDecision };
    const deps = makeDeps({ gate });
    const reviewId = await seedReview(deps, EMAIL);

    const first = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(first.data).toBe('issued');
    expect(fetchDecision).toHaveBeenCalledTimes(1);

    const second = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });

    expect(second.data).toBe('issued');
    expect(fetchDecision).toHaveBeenCalledTimes(1);
    const issued = (await (deps.ledger as MemoryLedger).readRun(SESSION_ID)).data!
      .filter((e) => e.event === 'warrant.issued');
    expect(issued).toHaveLength(1);
  });

  it('losing the claim with no visible winner reports pending, never a fabricated outcome', async () => {
    // The `outcome ? ok(outcome) : ok('pending')` branch. A racer that loses the claim
    // append and then cannot see any warrant.issued or warrant.denied knows only that
    // somebody else is mid-flight. Reporting 'issued' there would tell the caller a
    // warrant exists on the strength of a collision alone: nothing about THIS call
    // completed the winner's claim, and no warrant may have been minted at all.
    const base = new MemoryLedger();
    const deps0 = makeDeps({ ledger: base, gate: approveGate() });
    const reviewId = await seedReview(deps0, EMAIL);

    const ledger = failAppendOf(base, 'review.decided', 'duplicate_review_claim');
    const deps = makeDeps({ ledger, gate: approveGate() });
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error).toBeNull();
    expect(r.data).toBe('pending');
    // The premise, asserted rather than assumed: there really is no outcome to see.
    const events = await eventsOf(base);
    expect(events).not.toContain('warrant.issued');
    expect(events).not.toContain('warrant.denied');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a duplicate on the terminal append with no competing outcome fails closed', async () => {
    // appendTerminalOutcome's "should be unreachable" branch. Without it the function
    // returns ok({ outcome: null }), resumeByPoll delivers 'denied' on the strength of
    // `null !== 'issued'`, and hands the caller ok(null): a Result whose data is
    // neither 'issued' nor 'denied' nor 'pending', which no caller type-checks for.
    const base = new MemoryLedger();
    const deps0 = makeDeps({ ledger: base, gate: approveGate() });
    const reviewId = await seedReview(deps0, EMAIL);

    const ledger = failAppendOf(base, 'warrant.issued', 'duplicate_review_claim');
    const deps = makeDeps({ ledger, gate: approveGate() });
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error?.code).toBe('resume_internal_error');
    expect(r.data).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a transient failure on the terminal append is retryable, not an internal error', async () => {
    // The `!== 'duplicate_review_claim'` test. Delete it and every append failure is
    // treated as a collision: the code looks for a competing outcome, finds none, and
    // reports resume_internal_error for what is a plain retryable write failure.
    const base = new MemoryLedger();
    const deps0 = makeDeps({ ledger: base, gate: approveGate() });
    const reviewId = await seedReview(deps0, EMAIL);

    const ledger = failAppendOf(base, 'warrant.issued', 'ledger_down');
    const deps = makeDeps({ ledger, gate: approveGate() });

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('ledger_append_error');
    expect(r.error?.type).toBe('transient');
  });

  it('a mint failure that collides with a real winner reports the winner, not its own failure', async () => {
    // The `joined` branch. This call's mint fails policy, so it tries to record its own
    // warrant.denied and collides with a concurrent resume that already recorded an
    // outcome for the same reviewRef. Reporting this call's mint error would tell the
    // caller the run was denied while the ledger says a warrant was issued and an email
    // is going out. The winner's outcome is the true one, and it must be delivered here
    // because this call has never delivered anything.
    const base = new MemoryLedger();
    const deps0 = makeDeps({ ledger: base, gate: govEditGate() });
    const reviewId = await seedReview(deps0, EMAIL);
    const requestId = (
      (await base.readRun(SESSION_ID)).data!.find((e) => e.event === 'review.submitted')!
        .payload as Record<string, unknown>
    )['requestId'] as string;

    // The concurrent winner's row, appended legitimately so the chain stays valid.
    expect((await base.append({
      runId: SESSION_ID, at: '2026-07-18T10:30:00.000Z', event: 'warrant.issued',
      principal: PRINCIPAL,
      payload: { requestId, warrantId: 'w-winner', reviewRef: reviewId, decidedBy: DECIDED_BY },
    })).error).toBeNull();

    const ledger = failAppendOf(base, 'warrant.denied', 'duplicate_review_claim');
    const deps = makeDeps({ ledger, gate: govEditGate() });
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
    expect(deliver).toHaveBeenCalledWith('approved');
  });

  it('an exception anywhere inside resolves as a typed error and never rejects', async () => {
    // The outer catch. resumeByPoll's contract is that it returns a Result; a caller
    // that does not wrap it in try/catch, which the Result shape actively invites,
    // would otherwise see an unhandled rejection instead of a retryable code.
    const throwing: Ledger = {
      append: async (_i: LedgerAppendInput) => err({ type: 'transient', code: 'x', message: 'x' }),
      readRun: async (_id: string) => { throw new Error('ledger exploded'); },
      readAll: async () => { throw new Error('ledger exploded'); },
    };
    const deps = makeDeps({ ledger: throwing, gate: approveGate() });

    const p = resumeByPoll(deps, { reviewId: 'x', runId: SESSION_ID, deliver: vi.fn() });

    await expect(p).resolves.toMatchObject({ error: { code: 'resume_internal_error' } });
    expect((await p).error?.message).toBe('ledger exploded');
  });

  it('the ordinary run still issues, so none of the above is refusing everything', async () => {
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const reviewId = await seedReview(deps, EMAIL);
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
    expect(deliver).toHaveBeenCalledWith('approved');
  });
});
