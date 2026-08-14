/**
 * adversarial.test.ts: Milestone B design spec section 12.2, the four adversarial security
 * requirements. These ARE the milestone's security acceptance criteria: each proves enforcement
 * lives in the ledger or the gate, never in eve's own approval UI and never in Gatewerk's
 * decided_by field alone.
 * Sections: R1 free-text approval bypass, R2 machine approval via a spoofed decided_by driven
 * through the real GatewerkGate, R3 step re-run double-send, R4 concurrent webhook resume (the
 * TOCTOU close, design section 6).
 * Key decisions: R2 exercises the real GatewerkGate.fetchDecision through an injected fetchImpl
 * instead of stubbing an already-mapped ReviewDecision, so the human-attestation allowlist in
 * warrant-gatewerk/src/decision.ts actually runs (see the inline comment on why a stub would be
 * vacuous here). R4 reuses the deterministic-interleaving technique already proven in
 * resume-claim.test.ts rather than hoping Promise.all races. Fixtures come from ./fixtures.ts,
 * the shared module resume-claim.test.ts and resume-orphan.test.ts already build on, not
 * duplicated inline.
 * Companion: tests/with-warrant-security.test.ts (Milestone A security suite).
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
import { GatewerkGate, SimGate } from '@idriszade/warrant-gatewerk';
import { withWarrant, resumeByPoll } from '../src/index.js';
import { MemoryParkStore } from '../src/park-store.js';
import type { WarrantToolBinding } from '../src/index.js';
import {
  SESSION_ID, PRINCIPAL, makeDeps, makeApprovalCtx, makeToolCtx, coldBinding, makePlainTool, seedReview,
} from './fixtures.js';
import type { EmailInput, EmailOutput } from './fixtures.js';

// ---------------------------------------------------------------------------------------------
// R1: free-text approval bypass (spec 12.2.1, docs/tools/human-in-the-loop.md:103)
// ---------------------------------------------------------------------------------------------
describe('R1: free-text approval bypass', () => {
  it('approval resolves user-approval; resumeByPoll is skipped entirely; execute throws warrant_missing, outbox stays empty', async () => {
    const outbox: EmailOutput[] = [];
    const sideEffect = vi.fn((_i: EmailInput): EmailOutput => {
      const o = { messageId: `sent-${outbox.length + 1}` };
      outbox.push(o);
      return o;
    });
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, deps);
    const input: EmailInput = { to: 'prospect@corp.com', subject: 'Hi', body: 'Hello' };

    const approval = await tool.approval!(makeApprovalCtx({ toolInput: input }));
    // eve resolves a parked approval the moment a follow-up message's TEXT matches the
    // runtime's hardcoded approve/deny option id (docs/tools/human-in-the-loop.md:103), and the
    // approval callback does not re-fire on resume. This models the attacker's outcome
    // directly: skip resumeByPoll entirely (Gatewerk is still pending) and go straight to
    // execute, exactly what eve does after resolving the approval.
    expect(approval).toBe('user-approval');

    await expect(tool.execute(input, makeToolCtx())).rejects.toThrow('warrant_missing');
    expect(sideEffect).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R2: machine approval via a spoofed decided_by (spec 12.2.2, spec 2.2, gatewerk decision.ts
// last_action_by allowlist). Drives the REAL GatewerkGate through an injected fetchImpl, so the
// actual mapReviewDecision guard runs rather than a hand-built ReviewDecision that would bypass
// the very guard under test.
// ---------------------------------------------------------------------------------------------
describe('R2: machine approval via spoofed decided_by', () => {
  it('agent-authenticated decision with a human-looking decided_by: human_attestation_missing, no warrant.issued, execute refuses', async () => {
    const REVIEW_ID = 'review-machine-1';

    const fetchImpl = vi.fn()
      // approval() -> gate.submit(): Gatewerk creates the review.
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: REVIEW_ID }), { status: 201 }))
      // resumeByPoll -> gate.fetchDecision(): Gatewerk's api-key decision path writes decided_by
      // as a bare, spoofable string (decide.ts lets an api-key caller overwrite it to anything).
      // last_action_by is the field Gatewerk actually maintains and cannot be spoofed the same
      // way: 'agent:...' means an API-key session decided this, never an authenticated reviewer.
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: REVIEW_ID,
        status: 'decided',
        decision: 'approved',
        decided_by: 'alice@corp.example', // spoofed human name
        last_action_by: 'agent:gwk_live_7f3a',
      }), { status: 200 }));

    const gate = new GatewerkGate({
      baseUrl: 'https://gatewerk.test',
      apiKey: 'gwk_test',
      callbackUrl: 'https://eve.test/warrant/v1/gatewerk/review',
      templateSlug: 'warrant-outbound-email',
      fetchImpl,
    });

    const outbox: EmailOutput[] = [];
    const sideEffect = vi.fn((_i: EmailInput): EmailOutput => {
      const o = { messageId: `sent-${outbox.length + 1}` };
      outbox.push(o);
      return o;
    });
    const deps = makeDeps({ gate });
    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, deps);
    const input: EmailInput = { to: 'prospect@corp.com', subject: 'Hi', body: 'Hello' };

    const approval = await tool.approval!(makeApprovalCtx({ toolInput: input }));
    expect(approval).toBe('user-approval');

    const result = await resumeByPoll(deps, { reviewId: REVIEW_ID, runId: SESSION_ID, deliver: async () => {} });
    expect(result.error?.code).toBe('human_attestation_missing');

    const all = await (deps.ledger as MemoryLedger).readAll();
    const events = all.data!.map((e: LedgerEntry) => e.event);
    expect(events).not.toContain('warrant.issued');
    expect(events).not.toContain('review.decided');

    await expect(tool.execute(input, makeToolCtx())).rejects.toThrow('warrant_missing');
    expect(sideEffect).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R3: step re-run double-send (eve durability docs: an interrupted step re-runs, side effects
// must be idempotent). The defense is warrant-ledger's nonce_spent uniqueness check on
// action.executed (packages/warrant-ledger/src/memory.ts).
// ---------------------------------------------------------------------------------------------
describe('R3: step re-run double-send', () => {
  it('execute invoked twice for one callId: the second call fails on the spent nonce, outbox has exactly one entry', async () => {
    const outbox: EmailOutput[] = [];
    const sideEffect = vi.fn((_i: EmailInput): EmailOutput => {
      const o = { messageId: `sent-${outbox.length + 1}` };
      outbox.push(o);
      return o;
    });
    // Auto path (no audience in context): mints on approval, no human review in the loop, so
    // the double-execute is isolated to the execute-side nonce guard this requirement targets.
    const autoBinding: WarrantToolBinding<EmailInput> = {
      actionKind: 'send_email',
      principal: PRINCIPAL,
      toTarget: (i) => i.to,
      toParams: (i) => ({ to: i.to, subject: i.subject, body: i.body }),
      toContext: (_i) => ({}),
      toReviewTitle: (i) => `Send email to ${i.to}`,
      toReviewContent: (i) => ({ subject: i.subject, body: i.body, to: i.to }),
    };
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), autoBinding, deps);
    const input: EmailInput = { to: 'user@example.com', subject: 'Test', body: 'Body' };

    const approval = await tool.approval!(makeApprovalCtx({ toolInput: input }));
    expect(approval).toBe('approved');

    const ctx = makeToolCtx();
    const out1 = await tool.execute(input, ctx);
    expect(out1.messageId).toBe('sent-1');

    // Simulates eve re-running an interrupted workflow step: same callId, same input.
    await expect(tool.execute(input, ctx)).rejects.toThrow(/execute_nonce_spent/);
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(outbox).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// R4: concurrent webhook resume, the TOCTOU close (spec section 6). Reuses the deterministic
// interleaving technique from resume-claim.test.ts: the SECOND racer's claim append is forced to
// wait for the FIRST racer's warrant.issued to actually commit, so the ledger's own
// check-then-push uniqueness decides the winner instead of hoping Promise.all interleaves.
// ---------------------------------------------------------------------------------------------
describe('R4: concurrent webhook resume', () => {
  it('two concurrent resumeByPoll for one reviewId: one claim, one warrant, one send, loser mirrors the winner', async () => {
    const mem = new MemoryLedger();
    const deliver = vi.fn(async (_o: 'approved' | 'denied') => {});
    // One shared gate instance: racingDeps must be able to fetchDecision() for the reviewId
    // seedDeps.gate.submit() minted, or the race never gets off the ground.
    const gate = new SimGate(['approve']);
    const seedDeps = makeDeps({ ledger: mem, gate });
    const emailInput: EmailInput = { to: 'prospect@corp.com', subject: 'Race', body: 'Body' };
    const reviewId = await seedReview(seedDeps, emailInput);

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
      readRun: (id: string) => mem.readRun(id),
      readAll: () => mem.readAll(),
    };
    const racingDeps = makeDeps({ ledger: racingLedger, gate, parkStore: new MemoryParkStore() });

    const [r1, r2] = await Promise.all([
      resumeByPoll(racingDeps, { reviewId, runId: SESSION_ID, deliver }),
      resumeByPoll(racingDeps, { reviewId, runId: SESSION_ID, deliver }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r1.data).toBe('issued');
    expect(r2.data).toBe('issued'); // the loser mirrors the winner's outcome, never an error

    const all = (await mem.readAll()).data!;
    expect(all.filter((e: LedgerEntry) => e.event === 'review.decided')).toHaveLength(1);
    expect(all.filter((e: LedgerEntry) => e.event === 'warrant.issued')).toHaveLength(1);
    expect(claimAttempts).toBe(2); // proves both racers genuinely reached the claim append

    // Exactly one legitimate warrant exists, so exactly one execute can ever send.
    const outbox: EmailOutput[] = [];
    const sideEffect = vi.fn((_i: EmailInput): EmailOutput => {
      const o = { messageId: 'sent-toctou' };
      outbox.push(o);
      return o;
    });
    const tool = withWarrant(makePlainTool(sideEffect), coldBinding, seedDeps);
    await tool.execute(emailInput, makeToolCtx());
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(outbox).toHaveLength(1);
  });
});
