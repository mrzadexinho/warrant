// eve re-invokes the approval callback when a parked call is resumed, carrying the SAME
// callId. Without a guard: a real human approves, `warrant.issued` is appended, the agent wakes,
// and the approval callback runs AGAIN for the same callId. `requestAuthority` duly appends a
// second `warrant.requested` + `policy.evaluated`, policy reaches `human` a second time, and
// `gate.submit` is then refused because it sends `idempotency_key: requestId` and Gatewerk has
// already seen that key. A submit failure appends nothing, so the run stops with the outbox empty
// and no further entry written.
//
// The property under test is therefore NOT "the guard returns approved": it is **that the second
// pass appends nothing to the ledger and never touches the gate.** Asserting only the return value
// would pass against a version that re-ran the whole sequence and then returned 'approved' anyway.
import { describe, it, expect } from 'vitest';
import { ok } from '@idriszade/core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Gate, ReviewRequest } from '@idriszade/warrant-gatewerk';
import { withWarrant } from '../src/index.js';
import type { ReentryCheckInfo } from '../src/index.js';
import { SESSION_ID, coldBinding, makeApprovalCtx, makeDeps, makePlainTool } from './fixtures.js';

const CALL_ID = 'call_resumed_same_id';

/** Records every submit so a re-entry that reaches the gate is visible, not merely implied. */
function countingGate(): { gate: Gate; submits: ReviewRequest[] } {
  const submits: ReviewRequest[] = [];
  return {
    submits,
    gate: {
      submit: async (r: ReviewRequest) => { submits.push(r); return ok({ reviewId: `rev-${submits.length}` }); },
      fetchDecision: async () => ok({ pending: true as const }),
    } as unknown as Gate,
  };
}

async function runApprovalTwice(seedTerminal: 'warrant.issued' | 'warrant.denied' | 'none') {
  const ledger = new MemoryLedger();
  const { gate, submits } = countingGate();
  const deps = makeDeps({ ledger, gate });
  const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
  const ctx = makeApprovalCtx({ callId: CALL_ID });

  // First pass: the real human path. Parks, submits one review.
  const first = await tool.approval!(ctx);

  if (seedTerminal !== 'none') {
    // Stand in for what resumeByPoll writes after the human decides.
    await ledger.append({
      runId: SESSION_ID,
      at: new Date().toISOString(),
      event: seedTerminal,
      principal: coldBinding.principal,
      payload: { requestId: CALL_ID, reviewRef: 'rev-1' },
    });
  }

  const before = (await ledger.readRun(SESSION_ID)).data!.length;
  const submitsBefore = submits.length;

  // Second pass: eve re-invoking the callback on resume, same callId.
  const second = await tool.approval!(ctx);

  const after = (await ledger.readRun(SESSION_ID)).data!.length;
  return { first, second, appended: after - before, gateCalls: submits.length - submitsBefore };
}

describe('approval re-entry on resume', () => {
  it('after warrant.issued: approves without appending anything or touching the gate', async () => {
    const r = await runApprovalTwice('warrant.issued');
    expect(r.first).toBe('user-approval');
    expect(r.second).toBe('approved');
    // The two that actually matter: a re-run would break both.
    expect(r.appended).toBe(0);
    expect(r.gateCalls).toBe(0);
  });

  it('after warrant.denied: denies, and still appends nothing and never re-submits', async () => {
    const r = await runApprovalTwice('warrant.denied');
    expect(r.second).toEqual({ type: 'denied', reason: 'already_denied' });
    expect(r.appended).toBe(0);
    expect(r.gateCalls).toBe(0);
  });

  it('with NO terminal outcome the guard stays out of the way: the normal path still runs', async () => {
    // The control. Without this, a guard that short-circuits unconditionally would pass both
    // tests above while breaking every first-time approval in the system.
    const r = await runApprovalTwice('none');
    expect(r.second).toBe('user-approval');
    expect(r.appended).toBeGreaterThan(0);
    expect(r.gateCalls).toBe(1);
  });

  it('the guard reports what it saw, on every run: proceed included', async () => {
    // The 'proceed' report is the load-bearing one: a process serving the resume that predates
    // the guard leaves NOTHING to say whether the guard ran at all. A guard that reports every
    // evaluation makes a stale image diagnosable by silence: an approval with no guard line is an
    // approval the deployed guard never saw.
    const seen: ReentryCheckInfo[] = [];
    const ledger = new MemoryLedger();
    const { gate } = countingGate();
    const deps = makeDeps({ ledger, gate, onReentryCheck: (info) => { seen.push(info); } });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    const ctx = makeApprovalCtx({ callId: CALL_ID });

    await tool.approval!(ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId: SESSION_ID, callId: CALL_ID, matched: 0, decision: 'proceed' });

    await ledger.append({
      runId: SESSION_ID, at: new Date().toISOString(), event: 'warrant.issued',
      principal: coldBinding.principal, payload: { requestId: CALL_ID, reviewRef: 'rev-1' },
    });
    const entryCount = (await ledger.readRun(SESSION_ID)).data!.length;

    const second = await tool.approval!(ctx);
    expect(second).toBe('approved');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      runId: SESSION_ID, callId: CALL_ID, entries: entryCount, matched: 1, decision: 'prior_approved',
    });
  });

  it('reports prior_denied and read_failed with the decisions they accompany', async () => {
    const seen: ReentryCheckInfo[] = [];
    const denied = await (async () => {
      const ledger = new MemoryLedger();
      const deps = makeDeps({ ledger, gate: countingGate().gate, onReentryCheck: (i) => { seen.push(i); } });
      const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
      await ledger.append({
        runId: SESSION_ID, at: new Date().toISOString(), event: 'warrant.denied',
        principal: coldBinding.principal, payload: { requestId: CALL_ID, reviewRef: 'rev-1' },
      });
      return tool.approval!(makeApprovalCtx({ callId: CALL_ID }));
    })();
    expect(denied).toEqual({ type: 'denied', reason: 'already_denied' });
    expect(seen.at(-1)).toMatchObject({ matched: 1, decision: 'prior_denied' });

    const failing = {
      append: async () => { throw new Error('unreachable in this test'); },
      readRun: async () => ({ error: { type: 'transient' as const, code: 'db_down', message: 'stub' }, data: undefined }),
      readAll: async () => ({ error: { type: 'transient' as const, code: 'db_down', message: 'stub' }, data: undefined }),
    };
    const deps = makeDeps({ ledger: failing as never, gate: countingGate().gate, onReentryCheck: (i) => { seen.push(i); } });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    const out = await tool.approval!(makeApprovalCtx({ callId: CALL_ID }));
    expect(out).toEqual({ type: 'denied', reason: 'reentry_check_failed' });
    expect(seen.at(-1)).toMatchObject({ entries: 0, matched: 0, decision: 'read_failed' });
  });

  it('a throwing reporter never changes the outcome: same rule as resume.ts\'s deliver reporter', async () => {
    const ledger = new MemoryLedger();
    const { gate, submits } = countingGate();
    const deps = makeDeps({ ledger, gate, onReentryCheck: () => { throw new Error('reporter bug'); } });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    const ctx = makeApprovalCtx({ callId: CALL_ID });

    const first = await tool.approval!(ctx);
    expect(first).toBe('user-approval');
    expect(submits).toHaveLength(1);

    await ledger.append({
      runId: SESSION_ID, at: new Date().toISOString(), event: 'warrant.issued',
      principal: coldBinding.principal, payload: { requestId: CALL_ID, reviewRef: 'rev-1' },
    });
    const second = await tool.approval!(ctx);
    expect(second).toBe('approved');
  });

  it('a ledger read failure denies with its own reason rather than falling through', async () => {
    // Falling through would re-run the exact sequence the guard exists to prevent, so "cannot
    // see the ledger" must be its own answer and not an optimistic one.
    const base = new MemoryLedger();
    const ledger = {
      append: (i: Parameters<MemoryLedger['append']>[0]) => base.append(i),
      readRun: async () => ({ error: { type: 'transient' as const, code: 'db_down', message: 'stub' }, data: undefined }),
      readAll: () => base.readAll(),
    };
    const deps = makeDeps({ ledger: ledger as never, gate: countingGate().gate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    const out = await tool.approval!(makeApprovalCtx({ callId: CALL_ID }));
    expect(out).toEqual({ type: 'denied', reason: 'reentry_check_failed' });
  });
});
