// tests/resume-orphan.test.ts: the step-3b orphaned-claim fall-through (master C11), where a
// review.decided claim exists with no warrant.issued/warrant.denied yet, simulating a crash
// between the two appends, plus gate typed-error propagation and the park-absent contract.
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { resumeByPoll } from '../src/index.js';
import { MemoryParkStore } from '../src/park-store.js';
import { SESSION_ID, PRINCIPAL, makeDeps, seedReview } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

async function requestIdFor(mem: MemoryLedger, runId: string): Promise<string> {
  const all = (await mem.readAll()).data!;
  const reviewEntry = all.find(e => e.event === 'review.submitted' && e.runId === runId)!;
  return (reviewEntry.payload as Record<string, unknown>)['requestId'] as string;
}

describe('resumeByPoll: orphaned claim recovery (single caller)', () => {
  it('review.decided claim exists but no warrant.issued/denied yet: mints instead of a false issued or an error', async () => {
    const mem = new MemoryLedger();
    const gate = new SimGate(['approve']);
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ ledger: mem, gate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);
    const requestId = await requestIdFor(mem, SESSION_ID);

    // Simulate the step-3b crash window: the claim landed, the outcome append never ran.
    const claimAppend = await mem.append({
      runId: SESSION_ID, at: '2026-07-18T10:05:00.000Z', event: 'review.decided',
      principal: PRINCIPAL, payload: { requestId, reviewId, decision: 'approved', decidedBy: 'human:alice' },
    });
    expect(claimAppend.error).toBeNull();

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(result.error).toBeNull();
    expect(result.data).toBe('issued');
    expect(deliver).toHaveBeenCalledWith('approved');

    const all = (await mem.readAll()).data!;
    expect(all.filter(e => e.event === 'review.decided')).toHaveLength(1); // not re-claimed
    expect(all.filter(e => e.event === 'warrant.issued')).toHaveLength(1);
  });
});

describe('resumeByPoll: orphaned claim, two racers', () => {
  it('both racers see the pre-existing claim, both skip re-claiming, both independently mint: exactly one warrant.issued survives, the loser joins the winner outcome', async () => {
    const mem = new MemoryLedger();
    const gate = new SimGate(['approve']);
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const seedDeps = makeDeps({ ledger: mem, gate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(seedDeps, emailInput);
    const requestId = await requestIdFor(mem, SESSION_ID);

    // Pre-seed the orphaned claim BEFORE either racer starts, so both racers' step-1 readAll
    // observes claimAlready=true from the outset (this is what makes it "both hit the
    // orphaned-claim path", as opposed to the ordinary claim race covered in
    // resume-claim.test.ts, where neither racer has a pre-existing claim).
    const claimAppend = await mem.append({
      runId: SESSION_ID, at: '2026-07-18T10:05:00.000Z', event: 'review.decided',
      principal: PRINCIPAL, payload: { requestId, reviewId, decision: 'approved', decidedBy: 'human:alice' },
    });
    expect(claimAppend.error).toBeNull();

    // Force genuine interleaving at the MINT step (not the claim step, which both racers
    // skip): the SECOND racer's warrant.issued append is made to wait for the FIRST racer's
    // warrant.issued to actually commit. Both racers still run mintHumanWarrant to completion
    // independently before either one wins: issuedAttempts===2 below proves that both really
    // reached and attempted the append, not that one short-circuited before the other started.
    let releaseSecondRacer: () => void;
    const firstRacerIssued = new Promise<void>((resolve) => { releaseSecondRacer = resolve; });
    let issuedAttempts = 0;
    const racingLedger: Ledger = {
      append: async (i: LedgerAppendInput) => {
        if (i.event === 'warrant.issued') { issuedAttempts++; if (issuedAttempts === 2) await firstRacerIssued; }
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
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect([r1.data, r2.data].sort()).toEqual(['issued', 'issued']);

    const all = (await mem.readAll()).data!;
    expect(all.filter(e => e.event === 'review.decided')).toHaveLength(1); // the pre-seeded claim, never re-appended by either racer
    expect(all.filter(e => e.event === 'warrant.issued')).toHaveLength(1);
    expect(issuedAttempts).toBe(2); // proves both racers independently reached the mint/append step
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith('approved');
  });
});

describe('resumeByPoll: gate error propagation', () => {
  it('gate returns human_attestation_missing: resumeByPoll surfaces THAT code, not gate_unreachable', async () => {
    const suspectGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'attest-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        err({ type: 'validation', code: 'human_attestation_missing', message: 'decided_by was not a human identity: system:timeout' }),
    };
    const deps = makeDeps({ gate: suspectGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('human_attestation_missing');

    const events = (await (deps.ledger as MemoryLedger).readRun(SESSION_ID)).data!.map(e => e.event);
    expect(events).not.toContain('warrant.issued');
    expect(events).not.toContain('review.decided');
  });
});

describe('resumeByPoll: park record absent', () => {
  it('no park record for reviewId: resumeByPoll proceeds normally, no error', async () => {
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const parkCheck = await deps.parkStore.get(reviewId);
    expect(parkCheck.data).toBeNull();

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).toBeNull();
    expect(result.data).toBe('issued');
  });
});
