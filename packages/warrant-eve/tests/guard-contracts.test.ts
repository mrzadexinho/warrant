// Fail-closed guards that a mutation sweep found had NO coverage: deleting each one
// left all 483 tests across all nine warrant packages green.
//
// The codebase's standing rule is "fail-closed is a test, not a comment". These are
// the guards where the comment existed and the test did not. Each test below was
// checked by re-deleting its guard and confirming the test then fails, so none of
// them is vacuous.
//
// A note on severity, because the sweep overstated some of it: several of these have
// a downstream backstop (mintHumanWarrant re-runs evaluate() on the final content,
// and execute re-reads its warrant from the ledger), so removing one guard does not
// always produce a directly exploitable path. That does not make them optional. They
// are the layers the design says must not depend on each other, and an untested layer
// is one that silently stops existing.
import { describe, it, expect, vi } from 'vitest';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { resumeByPoll, withWarrant } from '../src/index.js';
import {
  SESSION_ID, CALL_ID, coldBinding, makeApprovalCtx, makeDeps, makePlainTool, makeToolCtx, seedReview,
} from './fixtures.js';
import type { EmailInput } from './fixtures.js';
import type { WarrantEveDeps } from '../src/index.js';

const EMAIL: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };

/** coldBinding with an empty context, so policy routes to the auto path and mints directly. */
const autoBinding = { ...coldBinding, toContext: (_i: EmailInput) => ({}) };

function issuedForCall(entries: Array<{ event: string; payload: unknown }>) {
  return entries.filter(
    (e) => e.event === 'warrant.issued'
      && (e.payload as Record<string, unknown>)['requestId'] === CALL_ID,
  );
}

async function eventsOf(deps: WarrantEveDeps): Promise<string[]> {
  return (await deps.ledger.readRun(SESSION_ID)).data!.map((e) => e.event);
}

describe('resumeByPoll provenance: a review cannot be resumed without its origin', () => {
  it('refuses when warrant.requested is absent (resume.ts:128)', async () => {
    // warrant.requested is not merely a breadcrumb: it is the ONLY source of
    // originalContext, which mintHumanWarrant feeds to evaluate() when it re-runs
    // policy on the final content. Resuming without it would run that
    // re-evaluation against an empty context, degrading the check that stops a
    // human edit smuggling a protected recipient past policy.
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const reviewId = await seedReview(deps, EMAIL);

    // Rebuild the run WITHOUT warrant.requested, by appending rather than by
    // splicing: fromEntries validates the chain, so a spliced run would fail on a
    // chain error and this test would pass for the wrong reason.
    const all = (await deps.ledger.readAll()).data!;
    const ledger = new MemoryLedger();
    for (const e of all.filter((x) => x.event !== 'warrant.requested')) {
      await ledger.append({ runId: e.runId, at: e.at, event: e.event, principal: e.principal, payload: e.payload });
    }
    const deps2 = makeDeps({ ledger, gate: new SimGate(['approve']) });

    const deliver = vi.fn();
    const r = await resumeByPoll(deps2, { reviewId, runId: SESSION_ID, deliver });
    expect(r.error?.code).toBe('missing_provenance');
    const events = (await ledger.readRun(SESSION_ID)).data!.map((e) => e.event);
    expect(events).not.toContain('warrant.issued');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses when policy never routed the request to human (resume.ts:136)', async () => {
    // This is the denied-to-approved laundering path. A request the policy evaluated
    // as deny must not become an issued human-path warrant just because a review and
    // an approval exist for its requestId.
    const deps = makeDeps({ gate: new SimGate(['approve']) });
    const reviewId = await seedReview(deps, EMAIL);

    const all = (await deps.ledger.readAll()).data!;
    const relabelled = all.map((e) =>
      e.event === 'policy.evaluated'
        ? { ...e, payload: { ...(e.payload as Record<string, unknown>), path: 'deny' } }
        : e,
    );
    // Re-hash: fromEntries validates the chain, so the tampered run must be
    // internally consistent. Otherwise this test would pass on a chain error rather
    // than on the provenance guard.
    const ledger = new MemoryLedger();
    for (const e of relabelled) {
      await ledger.append({ runId: e.runId, at: e.at, event: e.event, principal: e.principal, payload: e.payload });
    }
    const deps2 = makeDeps({ ledger, gate: new SimGate(['approve']) });

    const r = await resumeByPoll(deps2, { reviewId, runId: SESSION_ID, deliver: vi.fn() });
    expect(r.error?.code).toBe('missing_provenance');
    const events = (await ledger.readRun(SESSION_ID)).data!.map((e) => e.event);
    expect(events).not.toContain('warrant.issued');
  });
});

// execute.ts:28 reads `issuedEntries.length !== 1`, and the `!== 1` rather than `< 1` is
// the entire content of the guard: the zero case is covered several times over
// (with-warrant, resume, adversarial), the double-mint case was covered nowhere. Under
// `< 1` a second warrant for one callId is not an error, it is a silent choice of
// entries[0], and nothing anywhere records that the other authorization was discarded.
//
// The ledger reaches that state without any tampering: approval has no per-callId
// deduplication, so two approvals for one call append two warrant.issued rows. These
// tests drive the real approval path rather than stubbing readRun, because a stub could
// only prove execute reacts to a shape somebody handed it, not that the shape occurs.
describe('execute refuses a double-minted call rather than picking one of the warrants', () => {
  it('two identical mints for one callId: warrant_missing, no send, no action.executed', async () => {
    const deps = makeDeps();
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const tool = withWarrant(makePlainTool(sideEffect), autoBinding, deps);

    await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));
    await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));

    // The premise, asserted rather than assumed: if approval ever gains a dedup this
    // fails loudly instead of the test passing for the wrong reason.
    const issued = issuedForCall((await deps.ledger.readRun(SESSION_ID)).data!);
    expect(issued).toHaveLength(2);
    expect(new Set(issued.map((e) => (e.payload as Record<string, unknown>)['warrantId'])).size).toBe(2);

    await expect(tool.execute(EMAIL, makeToolCtx())).rejects.toThrow('warrant_missing');
    expect(sideEffect).not.toHaveBeenCalled();
    expect(await eventsOf(deps)).not.toContain('action.executed');
  });

  it('two mints authorizing DIFFERENT recipients: neither is contacted', async () => {
    // What `< 1` would actually do. The two warrants disagree about who gets the email,
    // entries[0] wins by ledger order alone, and the run proceeds as though the
    // authorization were unambiguous. Refusing is the only answer that does not invent
    // one, so the assertion is that no recipient was contacted, not merely that a
    // particular error came back.
    const deps = makeDeps();
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'x' }));
    const tool = withWarrant(makePlainTool(sideEffect), autoBinding, deps);

    const first: EmailInput = { to: 'first@example.com', subject: 'Intro', body: 'Hello' };
    const second: EmailInput = { to: 'second@example.com', subject: 'Intro', body: 'Hello' };
    await tool.approval!(makeApprovalCtx({ toolInput: first }));
    await tool.approval!(makeApprovalCtx({ toolInput: second }));
    expect(issuedForCall((await deps.ledger.readRun(SESSION_ID)).data!)).toHaveLength(2);

    await expect(tool.execute(first, makeToolCtx())).rejects.toThrow('warrant_missing');
    await expect(tool.execute(second, makeToolCtx())).rejects.toThrow('warrant_missing');
    expect(sideEffect).not.toHaveBeenCalled();
    expect(await eventsOf(deps)).not.toContain('action.executed');
  });

  it('exactly one mint still executes, so the guard is not just refusing everything', async () => {
    const deps = makeDeps();
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'sent' }));
    const tool = withWarrant(makePlainTool(sideEffect), autoBinding, deps);

    await tool.approval!(makeApprovalCtx({ toolInput: EMAIL }));
    expect(issuedForCall((await deps.ledger.readRun(SESSION_ID)).data!)).toHaveLength(1);

    await expect(tool.execute(EMAIL, makeToolCtx())).resolves.toEqual({ messageId: 'sent' });
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(await eventsOf(deps)).toContain('action.executed');
  });
});

describe('approval fails closed when the ledger cannot record what it claims', () => {
  it('a failed policy.evaluated append denies rather than proceeding (approval.ts:48)', async () => {
    // On the AUTO path this is the only thing between a ledger write failure and a
    // fully executed action. Without it the email goes out and the ledger holds
    // warrant.requested + warrant.issued + action.executed with no evidence a policy
    // was ever consulted: an audit trail asserting an evaluation that has no record.
    const { buildDeps, buildSendEmailTool } = await import('../../warrant-eve-outbound-demo/src/build.js');
    const outbox: Array<{ to: string }> = [];
    const base = new MemoryLedger();
    let failNext = false;
    const ledger = {
      append: async (input: Parameters<MemoryLedger['append']>[0]) => {
        if (input.event === 'policy.evaluated' && failNext) {
          return { data: null, error: { type: 'transient' as const, code: 'db_error', message: 'ledger down' } };
        }
        return base.append(input);
      },
      readRun: (id: string) => base.readRun(id),
      readAll: () => base.readAll(),
    };
    const deps = buildDeps({ ledger: ledger as unknown as MemoryLedger });
    const tool = buildSendEmailTool(deps, outbox as never);
    failNext = true;

    const ctx = {
      session: { id: SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
      approvedTools: new Set<string>(), callId: CALL_ID, toolName: 'send_email',
      toolInput: { to: 'user@corp.com', subject: 'S', body: 'B', audience: 'known' },
      getSandbox: async () => { throw new Error('n/a'); }, getSkill: () => { throw new Error('n/a'); },
    };
    const verdict = await tool.approval!(ctx as never);
    expect(verdict).toMatchObject({ type: 'denied' });
    const events = (await base.readAll()).data!.map((e) => e.event);
    expect(events).not.toContain('warrant.issued');
    expect(outbox).toHaveLength(0);
  });
});
