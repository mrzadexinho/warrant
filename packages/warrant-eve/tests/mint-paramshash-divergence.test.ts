// The two mint guards no real input can reach, and what they are actually for.
//
// resume-issue.ts ends with a paramsHash cross-check:
//
//   let ph: string;
//   try { ph = paramsHash(authorized); } catch { ...paramshash_mismatch... }   (A)
//   if (w.action.paramsHash !== ph) { ...paramshash_mismatch... }              (B)
//
// Neither can fire on any input the product can produce. issueWarrant computes
// paramsHash(request.action.params) over that SAME `authorized` object, inside its own
// try/catch, and returns err on a throw. So anything that would make (A) fire has
// already returned issue_failed one guard earlier, and (B) compares a deterministic
// function's output against itself. Both are dead code with respect to reachability,
// which is why a mutation sweep found no test could tell they were gone.
//
// They are not pointless: they are a tripwire on warrant-core. The whole product claim
// reduces to "action.paramsHash is the hash of the bytes the human authorized", and
// these two lines are the only place that assertion is checked rather than assumed. So
// the honest test is not a reachability test, it is a regression test on the tripwire:
// make the hash the caller computes disagree with the hash the warrant carries, and
// assert nothing gets minted.
//
// The mock is deliberately one-sided. resume-issue.ts imports paramsHash from the
// package barrel; issueWarrant imports it internally from './hash.js' and is untouched
// here. That is exactly the shape of the failure being simulated: two computations of
// the same hash that stopped agreeing.
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';

type HashBehaviour = 'real' | 'throw' | 'divergent';
let hashBehaviour: HashBehaviour = 'real';

vi.mock('@idriszade/warrant-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@idriszade/warrant-core')>();
  return {
    ...actual,
    paramsHash: (params: unknown) => {
      if (hashBehaviour === 'throw') throw new Error('simulated non-canonical params');
      if (hashBehaviour === 'divergent') return 'd'.repeat(64);
      return actual.paramsHash(params);
    },
  };
});

const { resumeByPoll } = await import('../src/index.js');
const { SESSION_ID, makeDeps, seedReview } = await import('./fixtures.js');
type EmailInput = import('./fixtures.js').EmailInput;

const EMAIL: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };

const approveGate: Gate = {
  submit: async (_r: ReviewRequest) => ok({ reviewId: 'ph-0' }),
  fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
    ok({ reviewId: id, decision: 'approved' as const, decidedBy: 'reviewer:erin' }),
};

/** Seeds with the real hash (approval hashes too), then arms the divergence. */
async function seedThenArm(behaviour: HashBehaviour) {
  hashBehaviour = 'real';
  const deps = makeDeps({ gate: approveGate });
  const reviewId = await seedReview(deps, EMAIL);
  hashBehaviour = behaviour;
  return { deps, reviewId };
}

describe('the mint refuses when the two paramsHash computations disagree', () => {
  it('a hash that diverges from the one inside the warrant blocks the mint', async () => {
    const { deps, reviewId } = await seedThenArm('divergent');
    const deliver = vi.fn();
    try {
      const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

      expect(r.error?.code).toBe('paramshash_mismatch');
      expect(r.error?.type).toBe('integrity');
      expect(r.error?.message).toMatch(/diverged/);
      const entries = (await deps.ledger.readRun(SESSION_ID)).data!;
      // The signed warrant was already built by the time this fires. What matters is
      // that it never reaches the ledger, because a warrant.issued row is what every
      // downstream reader treats as the authorization.
      expect(entries.map((e) => e.event)).not.toContain('warrant.issued');
      const denied = entries.find((e) => e.event === 'warrant.denied');
      expect(denied).toBeDefined();
      expect((denied!.payload as Record<string, unknown>)['reason']).toBe('paramshash_mismatch');
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      hashBehaviour = 'real';
    }
  });

  it('a hash computation that throws is a typed refusal, not an escaped exception', async () => {
    const { deps, reviewId } = await seedThenArm('throw');
    try {
      const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });

      expect(r.error?.code).toBe('paramshash_mismatch');
      expect(r.error?.message).toMatch(/threw/);
      expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event))
        .not.toContain('warrant.issued');
    } finally {
      hashBehaviour = 'real';
    }
  });

  it('with both computations agreeing the same run mints, so neither guard rejects everything', async () => {
    const { deps, reviewId } = await seedThenArm('real');
    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
  });
});
