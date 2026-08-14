import { describe, it, expect, vi } from 'vitest';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { generateKeyPair } from '@idriszade/warrant-core';
import { loadPolicy } from '@idriszade/warrant-policy';
import { replayRun } from '@idriszade/warrant-verify';
import { withWarrant } from '../src/index.js';
import type { WarrantEveDeps, WarrantToolBinding, PlainTool } from '../src/index.js';
import { MemoryParkStore } from '../src/park-store.js';

// ────────────────────────────────────────────────────────────
// Policy fixture
// ────────────────────────────────────────────────────────────
const POLICY_YAML = `
version: "1.0.0"
defaults:
  path: deny
stakes:
  - id: send_email_cold
    match:
      actionKind: send_email
      audience: cold
    path: human
  - id: send_email_auto
    match:
      actionKind: send_email
    path: auto
protectedAudiences:
  - "*@*.gov"
caps:
  perPrincipalDaily: {}
`.trim();

// ────────────────────────────────────────────────────────────
// Test doubles / helpers
// ────────────────────────────────────────────────────────────
const KEYS = generateKeyPair('11'.repeat(32));
const SESSION_ID = 'session-1';
const CALL_ID = 'call-1';
const PRINCIPAL = { kind: 'agent' as const, id: 'agent-outbound' };

type EmailInput = { to: string; subject: string; body: string };
type EmailOutput = { messageId: string };

function makeApprovalCtx(
  overrides: Partial<{ callId: string; toolInput: EmailInput | undefined }> = {},
): ApprovalContext<EmailInput> {
  const callId = overrides.callId ?? CALL_ID;
  const toolInput = 'toolInput' in overrides ? overrides.toolInput : { to: 'test@example.com', subject: 'Hello', body: 'World' };
  return {
    session: { id: SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId,
    toolName: 'send_email',
    toolInput,
    getSandbox: async () => { throw new Error('not in tests'); },
    getSkill: () => { throw new Error('not in tests'); },
  } satisfies ApprovalContext<EmailInput>;
}

function makeToolCtx(overrides: Partial<{ callId: string }> = {}): ToolContext {
  const callId = overrides.callId ?? CALL_ID;
  return {
    session: { id: SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId,
    toolName: 'send_email',
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('not in tests'); },
    getSkill: () => { throw new Error('not in tests'); },
    getToken: async () => { throw new Error('not in tests'); },
    requireAuth: () => { throw new Error('not in tests') as never; },
  } satisfies ToolContext;
}

function makeDeps(overrides: Partial<WarrantEveDeps> = {}): WarrantEveDeps {
  const policyResult = loadPolicy(POLICY_YAML);
  if (policyResult.error) throw new Error('policy load failed: ' + policyResult.error.message);
  let tick = 0;
  return {
    policy: policyResult.data,
    keys: KEYS,
    publicKeyHex: KEYS.publicKeyHex,
    ledger: new MemoryLedger(),
    gate: new SimGate(['approve']),
    now: () => new Date('2026-07-18T10:00:00.000Z'),
    newId: () => `id-${++tick}`,
    autoTtlMs: 60_000,
    humanTtlMs: 3_600_000,
    reviewTimeoutMs: 3_600_000,
    parkStore: new MemoryParkStore(),
    ...overrides,
  };
}

const binding: WarrantToolBinding<EmailInput> = {
  actionKind: 'send_email',
  principal: PRINCIPAL,
  toTarget: (i) => i.to,
  toParams: (i) => ({ to: i.to, subject: i.subject, body: i.body }),
  toContext: (_i) => ({}),
  toReviewTitle: (i) => `Send email to ${i.to}`,
  toReviewContent: (i) => ({ subject: i.subject, body: i.body, to: i.to }),
};

function makePlainTool<P = EmailInput>(execute: (params: P) => EmailOutput): PlainTool<P, EmailOutput> {
  return {
    description: 'Send an email',
    inputSchema: { type: 'object' as const, properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
    outputSchema: { type: 'object' as const, properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    execute: (params) => execute(params),
  };
}

// Helper: get ledger events for a run
async function getEvents(ledger: MemoryLedger) {
  const r = await ledger.readRun(SESSION_ID);
  if (r.error) throw new Error(r.error.message);
  return r.data.map(e => e.event);
}

// ────────────────────────────────────────────────────────────
// The context binding: producer meets verifier
// ────────────────────────────────────────────────────────────
describe('policy.evaluated binds the context it evaluated', () => {
  // Asserted through replayRun rather than by re-hashing the payload here. A test that
  // recomputes sha256(canonicalJson(context)) with the same call the producer used proves only
  // that sha256 is deterministic. Running the verifier is what proves the emitted field is the
  // one the verifier accepts: an emitted hash nobody checks is a dashboard, not a proof.
  it('the verifier reports the run bound, with no violations', async () => {
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    await tool.approval!(makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'T', body: 'B' } }));

    const entries = (await (deps.ledger as MemoryLedger).readAll()).data!;
    const report = replayRun(entries, SESSION_ID, () => new Date('2026-07-16T12:00:00.000Z'));
    expect(report.error).toBeNull();
    expect(report.data!.journeys[0]!.contextBinding).toBe('bound');
    expect(report.data!.violations).toEqual([]);
  });

  it('a swapped context after the fact is caught: that is what the binding is for', async () => {
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    await tool.approval!(makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'T', body: 'B' } }));

    // Rewrite the recorded context and re-chain, so the run is internally consistent and this
    // fails on the binding rather than on a chain error.
    const all = (await (deps.ledger as MemoryLedger).readAll()).data!;
    const ledger = new MemoryLedger();
    for (const e of all) {
      const payload = e.event === 'warrant.requested'
        ? { ...(e.payload as Record<string, unknown>), context: { audience: 'warm', smuggled: true } }
        : e.payload;
      await ledger.append({ runId: e.runId, at: e.at, event: e.event, principal: e.principal, payload });
    }

    const entries = (await ledger.readAll()).data!;
    const report = replayRun(entries, SESSION_ID, () => new Date('2026-07-16T12:00:00.000Z'));
    expect(report.error).toBeNull();
    expect(report.data!.journeys[0]!.contextBinding).toBe('mismatch');
    expect(report.data!.violations.map((v) => v.kind)).toEqual(['context_hash_mismatch']);
  });
});

// ────────────────────────────────────────────────────────────
// DENY: protected audience
// ────────────────────────────────────────────────────────────
describe('deny: protected audience', () => {
  it('returns {type:denied} and logs requested/evaluated/denied; no warrant.issued', async () => {
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    const ctx = makeApprovalCtx({ toolInput: { to: 'official@state.gov', subject: 'Hi', body: 'Hey' } });

    const result = await tool.approval!(ctx);

    expect(result).toMatchObject({ type: 'denied' });
    const events = await getEvents(deps.ledger as MemoryLedger);
    expect(events).toEqual(['warrant.requested', 'policy.evaluated', 'warrant.denied']);
    expect(events).not.toContain('warrant.issued');
  });
});

// ────────────────────────────────────────────────────────────
// AUTO happy path
// ────────────────────────────────────────────────────────────
describe('auto: happy path', () => {
  it('approval returns approved + warrant.issued; execute runs side-effect once', async () => {
    const sideEffect = vi.fn((_input: EmailInput) => ({ messageId: 'msg-42' }));
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);
    const approvalCtx = makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'Test', body: 'Body' } });

    // approval
    const approvalResult = await tool.approval!(approvalCtx);
    expect(approvalResult).toBe('approved');

    const eventsAfterApproval = await getEvents(deps.ledger as MemoryLedger);
    expect(eventsAfterApproval).toContain('warrant.issued');
    expect(eventsAfterApproval).toEqual(['warrant.requested', 'policy.evaluated', 'warrant.issued']);

    // execute
    const toolCtx = makeToolCtx();
    const out = await tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, toolCtx);

    expect(out).toEqual({ messageId: 'msg-42' });
    expect(sideEffect).toHaveBeenCalledOnce();

    const eventsAfterExecute = await getEvents(deps.ledger as MemoryLedger);
    expect(eventsAfterExecute).toContain('action.executed');
    expect(eventsAfterExecute).toContain('action.outcome');
  });
});

// ────────────────────────────────────────────────────────────
// AUTO replay / double-spend
// ────────────────────────────────────────────────────────────
describe('auto: nonce double-spend', () => {
  it('second execute with same callId throws; side-effect ran once', async () => {
    const sideEffect = vi.fn((_input: EmailInput) => ({ messageId: 'msg-replay' }));
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);
    const emailInput: EmailInput = { to: 'user@example.com', subject: 'Replay', body: 'Test' };
    const approvalCtx = makeApprovalCtx({ toolInput: emailInput });

    await tool.approval!(approvalCtx);

    const toolCtx = makeToolCtx();
    await tool.execute(emailInput, toolCtx);
    expect(sideEffect).toHaveBeenCalledOnce();

    await expect(tool.execute(emailInput, toolCtx)).rejects.toThrow('execute_nonce_spent');
    expect(sideEffect).toHaveBeenCalledOnce(); // still only once
  });
});

// ────────────────────────────────────────────────────────────
// HUMAN approval-side
// ────────────────────────────────────────────────────────────
describe('human: approval side', () => {
  it('approval returns user-approval; review.submitted present with content; no warrant.issued', async () => {
    const deps = makeDeps();
    const coldBinding: WarrantToolBinding<EmailInput> = {
      ...binding,
      toContext: (_i) => ({ audience: 'cold' }), // triggers human rule
    };
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'cold-msg' })), coldBinding, deps);
    const approvalCtx = makeApprovalCtx({ toolInput: { to: 'prospect@example.com', subject: 'Intro', body: 'Hi there' } });

    const result = await tool.approval!(approvalCtx);
    expect(result).toBe('user-approval');

    const events = await getEvents(deps.ledger as MemoryLedger);
    expect(events).toEqual(['warrant.requested', 'policy.evaluated', 'review.submitted']);
    expect(events).not.toContain('warrant.issued');

    // verify review.submitted payload has content
    const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
    const reviewEntry = r.data!.find(e => e.event === 'review.submitted');
    expect(reviewEntry).toBeDefined();
    const payload = reviewEntry!.payload as Record<string, unknown>;
    expect(payload['content']).toMatchObject({ to: 'prospect@example.com', subject: 'Intro', body: 'Hi there' });
  });
});

// ────────────────────────────────────────────────────────────
// FAIL-CLOSED scenarios
// ────────────────────────────────────────────────────────────
describe('fail-closed', () => {
  it('(a) ledger append error on warrant.requested → approval returns denied', async () => {
    const brokenLedger = new MemoryLedger();
    const originalAppend = brokenLedger.append.bind(brokenLedger);
    let callCount = 0;
    brokenLedger.append = async (input) => {
      callCount++;
      if (callCount === 1 && input.event === 'warrant.requested') {
        return { data: null, error: { type: 'transient', code: 'ledger_down', message: 'forced error' } };
      }
      return originalAppend(input);
    };

    const deps = makeDeps({ ledger: brokenLedger });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    const approvalCtx = makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'Test', body: 'Body' } });

    const result = await tool.approval!(approvalCtx);
    expect(result).toMatchObject({ type: 'denied' });

    // No warrant.issued must have been written (ledger was broken before reaching it)
    const events = await brokenLedger.readRun(SESSION_ID);
    expect(events.data!.map(e => e.event)).not.toContain('warrant.issued');
  });

  it('(b) non-canonical params (BigInt) → issueWarrant errs → approval denied', async () => {
    type BigIntParams = { n: bigint };
    const badBinding: WarrantToolBinding<EmailInput, BigIntParams> = {
      ...binding,
      // BigInt makes paramsHash throw → non-canonical
      toParams: (_i) => ({ n: BigInt(10) }),
    };
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool<BigIntParams>(() => ({ messageId: 'x' })), badBinding, deps);
    const approvalCtx = makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'Test', body: 'Body' } });

    const result = await tool.approval!(approvalCtx);
    expect(result).toMatchObject({ type: 'denied' });

    const events = await getEvents(deps.ledger as MemoryLedger);
    expect(events).not.toContain('warrant.issued');
  });

  it('(c) execute with callId that has no warrant.issued → throws warrant_missing', async () => {
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);

    // Run approval for one callId but execute with a different one
    const approvalCtx = makeApprovalCtx({ toolInput: { to: 'user@example.com', subject: 'Test', body: 'Body' } });
    await tool.approval!(approvalCtx);

    const toolCtx = makeToolCtx({ callId: 'different-call-id' });
    await expect(
      tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, toolCtx)
    ).rejects.toThrow('warrant_missing');
  });

  it('(d) warrant expired → execute throws warrant_warrant_expired', async () => {
    let nowMs = new Date('2026-07-18T10:00:00.000Z').getTime();
    const deps = makeDeps({
      autoTtlMs: 1,          // 1ms TTL
      now: () => new Date(nowMs),
    });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    const emailInput: EmailInput = { to: 'user@example.com', subject: 'Test', body: 'Body' };
    const approvalCtx = makeApprovalCtx({ toolInput: emailInput });

    await tool.approval!(approvalCtx);

    // Advance time past expiry
    nowMs += 10_000;

    const toolCtx = makeToolCtx();
    await expect(
      tool.execute(emailInput, toolCtx)
    ).rejects.toThrow('warrant_warrant_expired');
  });

  it('(e) params mismatch → execute throws params_mismatch', async () => {
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    const emailInput: EmailInput = { to: 'user@example.com', subject: 'Approved', body: 'This is the approved body' };
    const approvalCtx = makeApprovalCtx({ toolInput: emailInput });

    await tool.approval!(approvalCtx);

    // Execute with DIFFERENT params (different body)
    const toolCtx = makeToolCtx();
    const tamperedInput: EmailInput = { to: 'user@example.com', subject: 'Approved', body: 'TAMPERED BODY' };
    await expect(
      tool.execute(tamperedInput, toolCtx)
    ).rejects.toThrow('params_mismatch');
  });
});
