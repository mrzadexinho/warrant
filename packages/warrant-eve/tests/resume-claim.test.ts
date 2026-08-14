// tests/resume-claim.test.ts: the step-6b park cross-check, a mint failure recorded after the
// claim, and the concurrent-resume TOCTOU close at the CLAIM append (master C11, design §6).
// The double-orphaned-claim race (both racers skipping the claim and colliding at the MINT
// append instead) lives in ./resume-orphan.test.ts, alongside gate-error propagation.
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { ok } from '@idriszade/core';
import { replayRun } from '@idriszade/warrant-verify';
import { resumeByPoll } from '../src/index.js';
import { MemoryParkStore } from '../src/park-store.js';
import { SESSION_ID, CALL_ID, makeDeps, seedReview } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

describe('resumeByPoll: park correlation mismatch', () => {
  it('park callId differs from ledger requestId → park_correlation_mismatch; no mint', async () => {
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);
    await deps.parkStore.put({ reviewId, runId: SESSION_ID, callId: 'wrong-call-id', eveRequestId: 'eve-req-1', continuationToken: 'tok-1', parkedAt: '2026-07-18T10:00:00.000Z' });

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error!.code).toBe('park_correlation_mismatch');

    const events = (await (deps.ledger as MemoryLedger).readRun(SESSION_ID)).data!.map(e => e.event);
    expect(events).not.toContain('warrant.issued');
    expect(events).not.toContain('review.decided');
  });
});

describe('resumeByPoll: mint failure after claim', () => {
  it('policy denies final edited content: claim recorded; warrant.denied appended with reviewRef; journey replays denied', async () => {
    const govGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'claim-gov-0' }),
      fetchDecision: async (_id: string) => ok({ reviewId: 'claim-gov-0', decision: 'edited' as const, decidedBy: 'human:alice', editedContent: { subject: 'Hi', body: 'Body', to: 'ceo@treasury.gov' } } satisfies ReviewDecision),
    };
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ gate: govGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(result.error!.code).toBe('policy_denied_on_final');
    expect(deliver).not.toHaveBeenCalled();

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const events = r.data!.map(e => e.event);
    expect(events).toContain('review.decided');
    expect(events).toContain('warrant.denied');
    expect(events).not.toContain('warrant.issued');
    const deniedPayload = r.data!.find(e => e.event === 'warrant.denied')!.payload as Record<string, unknown>;
    expect(deniedPayload['reason']).toBe('policy_denied_on_final');
    // C3/C11: warrant.denied on the human path carries reviewRef, so it sits under the same
    // uniqueness guard as warrant.issued (master C5's second unique index).
    expect(deniedPayload['reviewRef']).toBe(reviewId);

    const report = replayRun(r.data!, SESSION_ID, () => new Date('2026-07-18T11:00:00.000Z'));
    expect(report.data!.journeys.find(j => j.requestId === CALL_ID)!.path).toBe('denied');
  });
});

describe('resumeByPoll: concurrent resume race', () => {
  it('two racers for one reviewId: exactly one review.decided, exactly one warrant.issued, loser returns the winner outcome', async () => {
    const mem = new MemoryLedger();
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const gate = new SimGate(['approve']);
    const reviewId = await seedReview(makeDeps({ ledger: mem, gate }), { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' });

    // Deterministic race: the SECOND racer's claim attempt waits for the FIRST racer's
    // warrant.issued to actually commit, so the loser fails via MemoryLedger's own
    // uniqueness check (Task 3), not a guess about JS microtask ordering. This genuinely
    // interleaves both calls: both start, both reach the claim append, and only the ledger's
    // own check-then-push decides the winner.
    let releaseSecondRacer: () => void;
    const firstRacerIssued = new Promise<void>((resolve) => { releaseSecondRacer = resolve; });
    let claimAttempts = 0;
    const racingLedger: Ledger = {
      append: async (i: LedgerAppendInput) => {
        if (i.event === 'review.decided') { claimAttempts++; if (claimAttempts === 2) await firstRacerIssued; }
        const r = await mem.append(i);
        if (i.event === 'warrant.issued') releaseSecondRacer();
        return r;
      },
      readRun: (id: string) => mem.readRun(id), readAll: () => mem.readAll(),
    };
    const racingDeps = makeDeps({ ledger: racingLedger, gate, parkStore: new MemoryParkStore() });

    const [r1, r2] = await Promise.all([
      resumeByPoll(racingDeps, { reviewId, runId: SESSION_ID, deliver }),
      resumeByPoll(racingDeps, { reviewId, runId: SESSION_ID, deliver }),
    ]);
    expect([r1.data, r2.data].sort()).toEqual(['issued', 'issued']);

    const all = (await mem.readAll()).data!;
    expect(all.filter(e => e.event === 'review.decided')).toHaveLength(1);
    expect(all.filter(e => e.event === 'warrant.issued')).toHaveLength(1);
    expect(claimAttempts).toBe(2); // proves both racers genuinely reached the claim append
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith('approved');
  });
});

describe('resumeByPoll: park store read failure fails closed', () => {
  it('a parkStore.get error denies the resume and mints nothing', async () => {
    // The park store is advisory plumbing, so an error reading it is tempting to ignore. It must
    // not be: skipping the step-6b cross-check on a read failure would let a resume proceed
    // without ever verifying that the park record agrees with the ledger, which is the check that
    // makes a poisoned park store unable to misroute an authorization. Fail closed instead.
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    deps.parkStore.get = async () =>
      ({ data: null, error: { type: 'transient', code: 'db_error', message: 'connection reset' } }) as never;

    const deliver = vi.fn();
    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(result.error!.code).toBe('park_read_error');
    expect(result.data).toBeNull();
    // Nothing was claimed, nothing was minted, and the parked run was never resumed.
    const events = (await (deps.ledger as MemoryLedger).readRun(SESSION_ID)).data!.map(e => e.event);
    expect(events).not.toContain('review.decided');
    expect(events).not.toContain('warrant.issued');
    expect(deliver).not.toHaveBeenCalled();
  });
});
