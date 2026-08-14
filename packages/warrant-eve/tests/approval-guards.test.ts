// Fail-closed guards in src/approval.ts and src/execute.ts that a mutation sweep found
// uncovered: deleting each one left warrant-eve and warrant-eve-outbound-demo green.
//
// approval.ts is the door. Everything it returns is a decision eve acts on, and every
// guard in it converts some internal failure into an explicit denial. The failure mode
// they all share is not that the action gets approved, but that the reason becomes
// approval_internal_error: an operator reading the ledger cannot tell a ledger outage
// from an unreachable gate from a binding that threw, and the run stops for a reason
// nobody can act on. Two of them are worse than that, and are marked below.
//
// Each test was checked by re-deleting its guard and confirming this test then fails,
// with the deletion diffed to prove it applied.
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { withWarrant } from '../src/index.js';
import type { WarrantToolBinding } from '../src/index.js';
import { KEYS, SESSION_ID, coldBinding, makeApprovalCtx, makeDeps, makePlainTool, makeToolCtx } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

const EMAIL: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };

/** Empty context, so the policy's send_email_auto stake routes this to the auto path. */
const autoBinding: WarrantToolBinding<EmailInput> = { ...coldBinding, toContext: (_i) => ({}) };
/** No stake matches this actionKind, so the policy default (deny) applies. */
const denyBinding: WarrantToolBinding<EmailInput> = { ...autoBinding, actionKind: 'drop_database' };

function failAppendOf(base: MemoryLedger, event: LedgerEntry['event'], code = 'db_down'): Ledger {
  return {
    append: async (i: LedgerAppendInput) =>
      i.event === event
        ? err({ type: 'transient' as const, code, message: `stub: ${code} on ${event}` })
        : base.append(i),
    readRun: (id: string) => base.readRun(id),
    readAll: () => base.readAll(),
  };
}

const okGate: Gate = {
  submit: async (_r: ReviewRequest) => ok({ reviewId: 'gate-ok-0' }),
  fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
    ok({ reviewId: id, decision: 'approved' as const, decidedBy: 'reviewer:erin' }),
};

describe('approval denies with a reason an operator can act on', () => {
  it('a call with no tool input is denied before anything is written', async () => {
    // Without the guard, binding.toTarget(undefined) throws on the very next line and
    // the outer catch reports approval_internal_error. Nothing has been appended at
    // that point either way, so the whole content of this guard is the diagnosis; the
    // assertion that the ledger stayed empty is what proves the guard is not doing
    // something else as well.
    const deps = makeDeps({ gate: okGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
    const ctx = { ...makeApprovalCtx(), toolInput: undefined as unknown as EmailInput };

    const verdict = await tool.approval!(ctx);

    expect(verdict).toEqual({ type: 'denied', reason: 'no_input' });
    expect((await deps.ledger.readRun(SESSION_ID)).data).toHaveLength(0);
  });

  it('a policy denial that cannot be recorded is denied as a ledger failure, not as the rule', async () => {
    // The reason string is the difference between "policy said no" and "we could not
    // write down that policy said no". Both deny, so nothing executes either way, but
    // only one of them is true, and the ledger is the artifact the certificate is
    // built from.
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'warrant.denied'), gate: okGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), denyBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'ledger_error' });
    expect((await base.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('warrant.denied');
  });

  it('a warrant that cannot be issued on the auto path denies rather than approving', async () => {
    // [CRITICAL] Not a diagnosis guard. Without it `issued.data` is null, the next
    // line reads `.id` off it, and only the outer catch stops the run: the difference
    // between issue_failed and approval_internal_error is cosmetic, but the guard is
    // also what stops a null warrant reaching the ledger if that ordering ever changes.
    const deps = makeDeps({ gate: okGate, keys: { privateKeyHex: 'not-a-key', publicKeyHex: KEYS.publicKeyHex } });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), autoBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'issue_failed' });
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('warrant.issued');
  });

  it('an auto-path warrant that cannot be recorded denies, and execute then has nothing to run on', async () => {
    // [CRITICAL] This is the one with a real hole behind it. Without the guard,
    // approval returns 'approved' while warrant.issued never reached the ledger. eve
    // then calls execute, which reads its warrant from the ledger and finds none.
    // The action does not go out, but only because a SECOND guard catches it: the
    // design says these layers must not depend on each other, so both halves are
    // asserted here.
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'warrant.issued'), gate: okGate });
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const tool = withWarrant(makePlainTool(sideEffect), autoBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'ledger_error' });
    await expect(tool.execute(EMAIL, makeToolCtx())).rejects.toThrow('warrant_missing');
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('params that cannot be canonicalised are denied by name, not by the catch-all', async () => {
    // Reached through a binding whose toParams returns a value canonicalJson refuses,
    // which is ordinary application code and not something this package controls. On
    // the human path nothing has hashed the params yet when this fires, so without the
    // guard the throw lands in the outer catch and the operator is told the adapter
    // broke rather than that their binding produced unhashable params.
    // The second type argument is the whole point: this binding's params are NOT its input, and
    // the handler is typed over what toParams actually produces. Before that parameter existed
    // the mismatch compiled and only showed up as an undefined read inside the handler.
    type DateParams = { scheduledFor: Date };
    const dateBinding: WarrantToolBinding<EmailInput, DateParams> = {
      ...coldBinding,
      toParams: (_i) => ({ scheduledFor: new Date('2026-07-18T10:00:00.000Z') }),
    };
    const deps = makeDeps({ gate: okGate });
    const tool = withWarrant(makePlainTool<DateParams>(() => ({ messageId: 'x' })), dateBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'params_noncanonical' });
    const events = (await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event);
    expect(events).not.toContain('review.submitted');
  });

  it('an unreachable gate is denied as unreachable, and no review is recorded', async () => {
    const downGate: Gate = {
      submit: async (_r: ReviewRequest) => err({ type: 'transient', code: 'gate_unreachable', message: 'timeout' }),
      fetchDecision: async (_id: string) => err({ type: 'transient', code: 'gate_unreachable', message: 'timeout' }),
    };
    const deps = makeDeps({ gate: downGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'gate_unreachable' });
    // Without the guard, submitResult.data is null and the append below records a
    // review.submitted whose reviewId is a read off null. Nothing may claim a review
    // exists when the gate never accepted one.
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('review.submitted');
  });

  it('a gate that answers with an HTTP refusal is denied as refused, not as unreachable', async () => {
    // The gate answered promptly and declined (a 400 SSRF rejection, a 401, a 409
    // idempotency conflict). Reporting that as gate_unreachable is a false claim about
    // the network.
    const refusingGate: Gate = {
      submit: async (_r: ReviewRequest) =>
        err({ type: 'transient', code: 'gatewerk_api_error', message: '409 Conflict' }),
      fetchDecision: async (_id: string) => err({ type: 'transient', code: 'gate_unreachable', message: 'n/a' }),
    };
    const deps = makeDeps({ gate: refusingGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'gate_refused' });
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('review.submitted');
  });

  it('a gate that answers 2xx with no usable review id is denied as an invalid response', async () => {
    const emptyBodyGate: Gate = {
      submit: async (_r: ReviewRequest) =>
        err({ type: 'validation', code: 'gatewerk_missing_review_id', message: 'no id' }),
      fetchDecision: async (_id: string) => err({ type: 'transient', code: 'gate_unreachable', message: 'n/a' }),
    };
    const deps = makeDeps({ gate: emptyBodyGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'gate_invalid_response' });
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('review.submitted');
  });

  it('a submit failure with an unrecognized code falls back to the internal-error catch-all', async () => {
    // Same convention as the requestAuthority switch above (:47): a code this switch
    // does not name must not silently borrow another branch's reason.
    const weirdGate: Gate = {
      submit: async (_r: ReviewRequest) => err({ type: 'transient', code: 'something_else', message: 'huh' }),
      fetchDecision: async (_id: string) => err({ type: 'transient', code: 'gate_unreachable', message: 'n/a' }),
    };
    const deps = makeDeps({ gate: weirdGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toEqual({ type: 'denied', reason: 'approval_internal_error' });
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('review.submitted');
  });

  it('a review that cannot be recorded denies instead of parking the agent forever', async () => {
    // [CRITICAL] Without the guard approval returns 'user-approval': eve parks the call
    // waiting for a review whose row does not exist, so resumeByPoll can only ever
    // answer review_not_found and the call never completes. Denying is the only
    // outcome that does not strand the run.
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'review.submitted'), gate: okGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    // review_append_failed, not ledger_error: this is the review.submitted append,
    // a different point in the sequence from requestAuthority's ledger_error above,
    // and the two must not share a reason an operator cannot tell apart.
    expect(verdict).toEqual({ type: 'denied', reason: 'review_append_failed' });
    expect(verdict).not.toBe('user-approval');
  });

  it('the ordinary auto path still approves and records its warrant', async () => {
    // The positive case for all seven above: an approval hardened into denying
    // everything satisfies every assertion in this describe block.
    const deps = makeDeps({ gate: okGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'sent' })), autoBinding, deps);

    const verdict = await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    expect(verdict).toBe('approved');
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).toContain('warrant.issued');
    await expect(tool.execute(EMAIL, makeToolCtx())).resolves.toEqual({ messageId: 'sent' });
  });
});

describe('execute throws named errors, never whatever the failure happened to throw', () => {
  it('a ledger that cannot be read throws ledger_read_error', async () => {
    // Without the guard `read.data` is null and .filter throws a TypeError. execute's
    // whole contract with the eve tool layer is that its failures are named, because
    // that name is what the caller branches on.
    const down: Ledger = {
      append: async (_i: LedgerAppendInput) => err({ type: 'transient', code: 'db_down', message: 'no' }),
      readRun: async (_id: string) => err({ type: 'transient', code: 'db_down', message: 'no' }),
      readAll: async () => err({ type: 'transient', code: 'db_down', message: 'no' }),
    };
    const deps = makeDeps({ ledger: down, gate: okGate });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), autoBinding, deps);

    await expect(tool.execute(EMAIL, makeToolCtx())).rejects.toThrow('ledger_read_error');
  });

  it('params that stop being canonicalisable between mint and execute throw params_noncanonical', async () => {
    // Reachable only through a binding whose toParams is not deterministic, which is
    // the point: this guard exists for application code that misbehaves, and the
    // warrant was minted over the hashable version. Without it the raw canonicalJson
    // error escapes execute in place of a named one. The side effect must not run
    // either way, and that is asserted rather than assumed.
    let call = 0;
    type DriftingParams = EmailInput | { at: Date };
    const driftingBinding: WarrantToolBinding<EmailInput, DriftingParams> = {
      ...autoBinding,
      toParams: (i) => (++call === 1 ? { to: i.to, subject: i.subject, body: i.body } : { at: new Date() }),
    };
    const deps = makeDeps({ gate: okGate });
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const tool = withWarrant(makePlainTool<DriftingParams>(sideEffect), driftingBinding, deps);

    expect(await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }))).toBe('approved');

    await expect(tool.execute(EMAIL, makeToolCtx())).rejects.toThrow('params_noncanonical');
    expect(sideEffect).not.toHaveBeenCalled();
    expect((await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event)).not.toContain('action.executed');
  });
});
