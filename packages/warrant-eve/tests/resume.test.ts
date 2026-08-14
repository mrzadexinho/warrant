// tests/resume.test.ts: resumeByPoll approve/edit/reject + idempotency + provenance/chain
// fail-closed coverage. Shared fixtures live in ./fixtures.ts; claim-ordering, park
// cross-check, and mint-failure coverage lives in ./resume-claim.test.ts; orphaned-claim
// recovery, the double-orphan race, and gate-error propagation live in ./resume-orphan.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerEntry, LedgerAppendInput } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { ReviewContent } from '@idriszade/warrant-gatewerk';

// The edit a simulated human makes. Supplied here, not by SimGate: the
// Gate port does not know that content has a `body`, so the test that means an
// email says so itself.
const editBody = (c: ReviewContent): ReviewContent => ({
  ...c, body: `${String(c['body'])}\n\n[edited in review]`,
});
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { withWarrant, resumeByPoll } from '../src/index.js';
import { SESSION_ID, CALL_ID, PRINCIPAL, makeToolCtx, makeDeps, coldBinding, makePlainTool, seedReview } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

// Every hand-built Gate below must return a decision a real Gate could have returned.
// decidedBy became required on ReviewDecision when C7 landed, and resume.ts writes it
// straight into review.decided and warrant.issued with no runtime default, so a mock
// omitting it was minting warrants whose human-review attestation said `undefined`.
const DECIDED_BY = 'reviewer:erin';

// ─── EXISTING TESTS (event-ordering adjusted: warrant.issued before review.decided) ───

describe('resumeByPoll: approve', () => {
  it('returns ok(issued); ledger has review.decided + warrant.issued (with authorized); deliver called approved', async () => {
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'resumed' }));
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(result.error).toBeNull();
    expect(result.data).toBe('issued');
    expect(deliver).toHaveBeenCalledWith('approved');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const events = r.data!.map(e => e.event);
    expect(events).toContain('review.decided');
    expect(events).toContain('warrant.issued');

    const issuedEntry = r.data!.find(e => e.event === 'warrant.issued');
    const issuedPayload = issuedEntry!.payload as Record<string, unknown>;
    expect(issuedPayload['authorized']).toBeDefined();
    expect(issuedPayload['warrant']).toBeDefined();

    // decidedBy is what makes the certificate's human-review claim checkable, and
    // resume.ts copies it from the decision with no default. Nothing anywhere asserted
    // it survives the trip into the ledger, which is how four mock gates came to omit
    // it and still typecheck as valid decisions.
    expect(issuedPayload['decidedBy']).toBe('sim-reviewer');
    const decidedEntry = r.data!.find(e => e.event === 'review.decided');
    expect(decidedEntry).toBeDefined();
    expect((decidedEntry!.payload as Record<string, unknown>)['decidedBy']).toBe('sim-reviewer');

    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, deps);
    const out = await tool.execute(emailInput, makeToolCtx());
    expect(out).toEqual({ messageId: 'resumed' });
    expect(sideEffect).toHaveBeenCalledOnce();
  });
});

describe('resumeByPoll: edit (GhostApproval)', () => {
  it('warrant bound to edited paramsHash; execute receives edited content', async () => {
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'edited' }));
    const deps = makeDeps({ gate: new SimGate(['edit'], { editContent: editBody }) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' };
    const reviewId = await seedReview(deps, emailInput);
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(result.data).toBe('issued');
    expect(deliver).toHaveBeenCalledWith('approved');

    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, deps);
    await tool.execute(emailInput, makeToolCtx());

    expect(sideEffect).toHaveBeenCalledOnce();
    const calledWith = sideEffect.mock.calls[0]![0];
    expect(calledWith.body).toContain('[edited in review]');
  });
});

describe('resumeByPoll: reject', () => {
  it('returns ok(denied); warrant.denied appended; deliver called denied; execute throws warrant_missing', async () => {
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ gate: new SimGate(['reject']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(result.data).toBe('denied');
    expect(deliver).toHaveBeenCalledWith('denied');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).toContain('warrant.denied');
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');

    // C3: the human-path warrant.denied carries reviewRef, putting the reject branch under
    // the same warrant_ledger_reviewref_uniq guard as the approve branch's warrant.issued.
    const deniedEntry = r.data!.find(e => e.event === 'warrant.denied');
    expect((deniedEntry!.payload as Record<string, unknown>)['reviewRef']).toBe(reviewId);

    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    await expect(tool.execute(emailInput, makeToolCtx())).rejects.toThrow('warrant_missing');
  });
});

describe('resumeByPoll: edited_no_content fail-closed', () => {
  it('gate returns edited decision without editedContent → err edited_no_content; no ledger changes', async () => {
    const badGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'bad-sim-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'bad-sim-0', decision: 'edited' as const, decidedBy: DECIDED_BY }),
    };
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ gate: badGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('edited_no_content');
    expect(deliver).not.toHaveBeenCalled();

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const events = r.data!.map(e => e.event);
    expect(events).not.toContain('review.decided');
    expect(events).not.toContain('warrant.issued');
  });
});

describe('resumeByPoll: idempotency', () => {
  it('two calls → exactly one warrant.issued; deliver called once', async () => {
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ gate: new SimGate(['approve', 'approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const r1 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    const r2 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r1.data).toBe('issued');
    expect(r2.data).toBe('issued');
    // Terminal idempotency re-delivers on each retry (at-most-once-effective via tryDeliver swallow)
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith('approved');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const issuedCount = r.data!.filter(e => e.event === 'warrant.issued').length;
    expect(issuedCount).toBe(1);
  });
});

describe('resumeByPoll: gate unreachable', () => {
  it('fetchDecision returns err → resumeByPoll propagates it UNMODIFIED (gate_unreachable here, since that is what a real Gate labels a genuine transport failure); no warrant.issued', async () => {
    const unreachableGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'gate-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        err({ type: 'transient', code: 'gate_unreachable', message: 'timeout' }),
    };
    const deps = makeDeps({ gate: unreachableGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('gate_unreachable');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
  });
});

describe('resumeByPoll: pending', () => {
  it('gate returns pending → ok(pending); ledger unchanged beyond review.submitted', async () => {
    const pendingGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'pend-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ pending: true }),
    };
    const deps = makeDeps({ gate: pendingGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const eventsBefore = r.data!.map(e => e.event);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.data).toBe('pending');

    const r2 = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r2.data!.map(e => e.event)).toEqual(eventsBefore);
  });
});

// ─── NEW SECURITY TESTS ────────────────────────────────────────────────────

describe('resumeByPoll: edited recipient hits protected audience', () => {
  it('editedContent.to = ceo@treasury.gov → err policy_denied_on_final; no warrant.issued; deliver not called', async () => {
    const govGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'gov-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'gov-0', decision: 'edited' as const, decidedBy: DECIDED_BY,
          editedContent: { subject: 'Hi', body: 'Body', to: 'ceo@treasury.gov' } }),
    };
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const deps = makeDeps({ gate: govGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('policy_denied_on_final');
    expect(deliver).not.toHaveBeenCalled();

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
  });
});

describe('resumeByPoll: edited recipient (allowed) target-binding', () => {
  it('signed warrant.action.target === editedContent.to; execute runs with edited to', async () => {
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'retargeted' }));
    const newTo = 'newprospect@corp.com';
    const editGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'edit-target-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'edit-target-0', decision: 'edited' as const, decidedBy: DECIDED_BY,
          editedContent: { subject: 'Intro', body: 'Hello there', to: newTo } }),
    };
    const deps = makeDeps({ gate: editGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.data).toBe('issued');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const issuedEntry = r.data!.find(e => e.event === 'warrant.issued');
    const w = (issuedEntry!.payload as Record<string, unknown>)['warrant'] as { action: { target: string } };
    expect(w.action.target).toBe(newTo);

    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, deps);
    await tool.execute(emailInput, makeToolCtx());
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(sideEffect.mock.calls[0]![0].to).toBe(newTo);
  });
});

describe('resumeByPoll: malformed review content', () => {
  it('editedContent missing to field → err malformed_review_content; no warrant.issued', async () => {
    const badContentGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'bad-content-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'bad-content-0', decision: 'edited' as const, decidedBy: DECIDED_BY,
          editedContent: { subject: 'x', body: 'y' } as ReviewDecision['editedContent'] }),
    };
    const deps = makeDeps({ gate: badContentGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('malformed_review_content');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
  });
});

describe('resumeByPoll: missing provenance', () => {
  it('review.submitted present but no warrant.requested / policy.evaluated → err missing_provenance', async () => {
    // Stub ledger: readAll returns entries with review.submitted but missing provenance entries
    const fakePrincipal = PRINCIPAL;
    const reviewEntry: LedgerEntry = {
      runId: SESSION_ID, at: '2026-07-18T10:00:00.000Z',
      event: 'review.submitted', principal: fakePrincipal,
      payload: { requestId: CALL_ID, reviewId: 'stub-0', content: { to: 'p@corp.com', subject: 'S', body: 'B' } },
      seq: 1, prevHash: '0'.repeat(64), hash: '',
    };
    // Patch hash so verifyChain passes (we skip chain verify by giving a valid-looking chain)
    // Easier: use a stub that bypasses readAll-based chain verify
    const stubLedger: Ledger = {
      append: async (i: LedgerAppendInput) => err({ type: 'transient', code: 'not_impl', message: 'stub' }),
      readRun: async (_id: string) => ok([reviewEntry]),
      readAll: async () => ok([reviewEntry]),  // verifyChain will fail on bad hash → we'll use a patched entry
    };

    // Build properly hashed single entry so chain verify passes
    const mem = new MemoryLedger();
    await mem.append({
      runId: SESSION_ID, at: '2026-07-18T10:00:00.000Z', event: 'review.submitted',
      principal: fakePrincipal,
      payload: { requestId: CALL_ID, reviewId: 'stub-0', content: { to: 'p@corp.com', subject: 'S', body: 'B' } },
    });
    const allEntries = (await mem.readAll()).data!;

    const provenanceLedger: Ledger = {
      append: async (i: LedgerAppendInput) => mem.append(i),
      readRun: async (_id: string) => ok(allEntries),
      readAll: async () => ok(allEntries),
    };

    const deps = makeDeps({ ledger: provenanceLedger, gate: new SimGate(['approve']) });
    const result = await resumeByPoll(deps, { reviewId: 'stub-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('missing_provenance');
  });

  // `originalContext` must never fall back to `payload(requestedEntry)['context'] ?? {}`, under
  // step 4's own heading "provenance (fail-closed, no silent defaults)".
  //
  // Substituting `{}` is not a lost field, it is a DIFFERENT re-evaluation. `mintHumanWarrant`
  // rebuilds an ActionRequest around this value and re-runs `evaluate()`, which reads
  // `request.context['audience']` (`evaluate.ts:53`) and returns the FIRST matching stakes rule,
  // and a rule with `match.audience === undefined` matches anything. So an absent context stops the
  // specific rule matching and falls through to a broader one, producing a signed warrant attesting
  // a ruleId that never governed the action. `mintHumanWarrant` only refuses on `deny`, so nothing
  // downstream catches it.
  async function ledgerWithRequestedPayload(payload: Record<string, unknown>): Promise<Ledger> {
    const mem = new MemoryLedger();
    const at = '2026-07-18T10:00:00.000Z';
    await mem.append({ runId: SESSION_ID, at, event: 'warrant.requested', principal: PRINCIPAL, payload });
    await mem.append({
      runId: SESSION_ID, at, event: 'policy.evaluated', principal: PRINCIPAL,
      payload: { requestId: CALL_ID, ruleId: 'exec-outreach', path: 'human', contextHash: 'x'.repeat(64) },
    });
    await mem.append({
      runId: SESSION_ID, at, event: 'review.submitted', principal: PRINCIPAL,
      payload: { requestId: CALL_ID, reviewId: 'ctx-0', content: { to: 'p@corp.com', subject: 'S', body: 'B' } },
    });
    const all = (await mem.readAll()).data!;
    return {
      append: async (i: LedgerAppendInput) => mem.append(i),
      readRun: async (_id: string) => ok(all),
      readAll: async () => ok(all),
    };
  }

  it('a warrant.requested carrying NO context refuses rather than re-evaluating against {}', async () => {
    // No `context` key at all, which is what a JS consumer or a cast produces, because
    // canonicalJson drops undefined keys before hashing and ActionRequestSchema is never
    // .parse()d in production.
    const ledger = await ledgerWithRequestedPayload({
      requestId: CALL_ID, actionKind: 'send_email', target: 'p@corp.com',
    });
    const deps = makeDeps({ ledger, gate: new SimGate(['approve']) });

    const r = await resumeByPoll(deps, { reviewId: 'ctx-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error).not.toBeNull();
    expect(r.error!.code).toBe('missing_provenance');
    // And nothing was minted on the way to refusing.
    const events = (await ledger.readAll()).data!.map((e) => e.event);
    expect(events).not.toContain('warrant.issued');
  });

  it.each([
    ['null', null],
    ['a string', 'audience=exec'],
    ['an array', ['exec']],
  ])('a warrant.requested whose context is %s refuses too', async (_label, ctx) => {
    const ledger = await ledgerWithRequestedPayload({
      requestId: CALL_ID, actionKind: 'send_email', target: 'p@corp.com', context: ctx,
    });
    const deps = makeDeps({ ledger, gate: new SimGate(['approve']) });

    const r = await resumeByPoll(deps, { reviewId: 'ctx-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('missing_provenance');
  });

  // The control, and it is what stops this becoming an over-refusal: an EMPTY context is a
  // legitimate value: `evaluate()` accepts `{}` and `ActionRequestSchema` types context as a
  // record that may be empty. Only ABSENCE is the fault. A guard that refused `{}` would break
  // every action whose policy does not depend on context.
  it('an empty-but-present context is legitimate and gets past the provenance gate', async () => {
    const ledger = await ledgerWithRequestedPayload({
      requestId: CALL_ID, actionKind: 'send_email', target: 'p@corp.com', context: {},
    });
    const deps = makeDeps({ ledger, gate: new SimGate(['approve']) });

    const r = await resumeByPoll(deps, { reviewId: 'ctx-0', runId: SESSION_ID, deliver: vi.fn() });

    // It may still fail further down the sequence: this asserts only that step 4b let it through.
    expect(r.error?.code).not.toBe('missing_provenance');
  });
});

describe('resumeByPoll: chain broken', () => {
  it('tampered entry hash → err chain_broken; no warrant.issued', async () => {
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    await seedReview(deps, emailInput);

    const all = (await (deps.ledger as MemoryLedger).readAll()).data!;
    // Tamper the first entry's payload (breaks its hash)
    const tampered = all.map((e, i) =>
      i === 0 ? { ...e, payload: { ...e.payload as object, tampered: true } } : e
    );

    const tamperedLedger: Ledger = {
      append: async (i: LedgerAppendInput) => (deps.ledger as MemoryLedger).append(i),
      readRun: async (_id: string) => ok(tampered.filter(e => e.runId === _id)),
      readAll: async () => ok(tampered),
    };
    const tamperedDeps = makeDeps({ ledger: tamperedLedger, gate: new SimGate(['approve']) });

    // reviewId from the original seeded run
    const reviewEntry = all.find(e => e.event === 'review.submitted')!;
    const reviewId = (reviewEntry.payload as Record<string, unknown>)['reviewId'] as string;

    const result = await resumeByPoll(tamperedDeps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('chain_broken');

    // No warrant.issued was appended
    expect(tampered.map(e => e.event)).not.toContain('warrant.issued');
  });
});

describe('resumeByPoll: partial failure then retry', () => {
  it('warrant.issued append fails first time; second call succeeds; only one warrant.issued total', async () => {
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    const mem = new MemoryLedger();
    let issuedAppendCount = 0;
    const faultyLedger: Ledger = {
      append: async (i: LedgerAppendInput) => {
        if (i.event === 'warrant.issued') {
          issuedAppendCount++;
          if (issuedAppendCount === 1) {
            return err({ type: 'transient', code: 'ledger_down', message: 'first attempt fails' });
          }
        }
        return mem.append(i);
      },
      readRun: (id: string) => mem.readRun(id),
      readAll: () => mem.readAll(),
    };
    const deps = makeDeps({ ledger: faultyLedger, gate: new SimGate(['approve', 'approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    // First attempt: warrant.issued append fails. Asserting the CODE, not merely that
    // some error came back: `not.toBeNull()` is satisfied by resume_internal_error too,
    // which is what appendTerminalOutcome returns if its duplicate-vs-transient
    // discrimination is removed. A mutation sweep walked straight through this test.
    const r1 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(r1.error?.code).toBe('ledger_append_error');
    expect(r1.error?.type).toBe('transient');

    // Second attempt: succeeds
    const r2 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(r2.data).toBe('issued');

    const all = (await mem.readAll()).data!;
    expect(all.filter(e => e.event === 'warrant.issued')).toHaveLength(1);
  });
});

describe('resumeByPoll: deliver throws then retry re-delivers', () => {
  it('deliver throws first time; warrant committed; retry hits idempotency and re-delivers', async () => {
    let deliverCallCount = 0;
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {
      deliverCallCount++;
      if (deliverCallCount === 1) throw new Error('delivery network error');
    });

    const deps = makeDeps({ gate: new SimGate(['approve', 'approve']) });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    // First call: warrant committed, tryDeliver throws but is swallowed
    const r1 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(r1.data).toBe('issued');  // returns ok even though deliver threw

    // Second call: hits idempotency (warrant.issued exists), calls tryDeliver again
    const r2 = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });
    expect(r2.data).toBe('issued');

    // Exactly one warrant.issued in ledger
    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.filter(e => e.event === 'warrant.issued')).toHaveLength(1);

    // deliver was called twice total (first threw, second succeeded)
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

// Gate is exported from this package's public surface (index.ts) and third parties are
// meant to implement it, so `decidedBy: string` is a compile-time promise only. Four of
// this repo's own mocks broke it before typecheck:tests existed, and two of those were
// minting. Nothing catches it at runtime: canonicalJson drops undefined keys before
// hashing, so the claim entry hashes clean, verifyChain passes, and the certificate
// attests a human review naming no human.
describe('resumeByPoll: the human attestation is required at the Gate boundary', () => {
  it('a decision with no decidedBy → err human_attestation_missing; nothing claimed, nothing minted', async () => {
    const noAttestGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'no-attest-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'no-attest-0', decision: 'approved' as const } as unknown as ReviewDecision),
    };
    const deps = makeDeps({ gate: noAttestGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('human_attestation_missing');

    // The check sits ahead of the claim, so an unattributable decision leaves no trace
    // of having been accepted at all.
    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).not.toContain('review.decided');
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
  });

  it('a blank decidedBy is refused the same way', async () => {
    const blankGate: Gate = {
      submit: async (_r: ReviewRequest) => ok({ reviewId: 'blank-attest-0' }),
      fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
        ok({ reviewId: 'blank-attest-0', decision: 'approved' as const, decidedBy: '   ' }),
    };
    const deps = makeDeps({ gate: blankGate });
    const emailInput: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
    const reviewId = await seedReview(deps, emailInput);

    const result = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('human_attestation_missing');

    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
  });
});
