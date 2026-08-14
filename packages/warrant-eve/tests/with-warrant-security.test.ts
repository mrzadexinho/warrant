/**
 * Security / adversarial tests for withWarrant (Tasks 1-3 review findings).
 * Companion to with-warrant.test.ts, imports shared helpers from a shared
 * fixtures module to stay ≤200 lines each.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerEntry, LedgerAppendInput } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { generateKeyPair, issueWarrant, paramsHash } from '@idriszade/warrant-core';
import type { Warrant, Principal } from '@idriszade/warrant-core';
import { loadPolicy } from '@idriszade/warrant-policy';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { withWarrant } from '../src/index.js';
import type { WarrantEveDeps, WarrantToolBinding, PlainTool } from '../src/index.js';
import { MemoryParkStore } from '../src/park-store.js';

// ─── shared fixtures (duplicated from with-warrant.test.ts to keep files independent) ───

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

const KEYS = generateKeyPair('11'.repeat(32));
const SESSION_ID = 'session-1';
const CALL_ID = 'call-1';
const PRINCIPAL: Principal = { kind: 'agent', id: 'agent-outbound' };

type EmailInput = { to: string; subject: string; body: string };
type EmailOutput = { messageId: string };

function makeApprovalCtx(opts: { callId?: string; sessionId?: string; toolInput?: EmailInput } = {}): ApprovalContext<EmailInput> {
  return {
    session: { id: opts.sessionId ?? SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId: opts.callId ?? CALL_ID,
    toolName: 'send_email',
    toolInput: opts.toolInput ?? { to: 'user@example.com', subject: 'Test', body: 'Body' },
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<EmailInput>;
}

function makeToolCtx(opts: { callId?: string; sessionId?: string } = {}): ToolContext {
  return {
    session: { id: opts.sessionId ?? SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId: opts.callId ?? CALL_ID,
    toolName: 'send_email',
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
    getToken: async () => { throw new Error('n/a'); },
    requireAuth: () => { throw new Error('n/a') as never; },
  } satisfies ToolContext;
}

function makeDeps(overrides: Partial<WarrantEveDeps> = {}): WarrantEveDeps {
  const policyResult = loadPolicy(POLICY_YAML);
  if (policyResult.error) throw new Error('policy load failed');
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

function makePlainTool<P = EmailInput>(fn: (params: P) => EmailOutput): PlainTool<P, EmailOutput> {
  return {
    description: 'Send an email',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    execute: (params) => fn(params),
  };
}

/** Build a one-shot auto warrant for testing execute() directly. */
function buildRealWarrant(opts: { runId?: string; target?: string; params?: unknown; ttlMs?: number } = {}): Warrant {
  const target = opts.target ?? 'user@example.com';
  const params = opts.params ?? { to: target, subject: 'Test', body: 'Body' };
  const policyResult = loadPolicy(POLICY_YAML);
  if (policyResult.error) throw new Error('policy load failed');
  let tick = 0;
  const result = issueWarrant(
    {
      request: {
        id: CALL_ID,
        runId: opts.runId ?? SESSION_ID,
        principal: PRINCIPAL,
        action: { kind: 'send_email', target, params },
        context: {},
      },
      verdict: {
        path: 'auto',
        ruleId: 'send_email_auto',
        policyVersion: policyResult.data.doc.version,
        policyHash: policyResult.data.hash,
        reason: 'matched stakes rule',
      },
      ttlMs: opts.ttlMs ?? 60_000,
    },
    { keys: KEYS, now: () => new Date('2026-07-18T10:00:00.000Z'), newId: () => `id-${++tick}` },
  );
  if (result.error) throw new Error('issueWarrant failed: ' + result.error.message);
  return result.data;
}

/** Minimal Ledger stub that returns a fixed readRun result. */
function makeStubLedger(issuedEntries: LedgerEntry[]): Ledger {
  const mem = new MemoryLedger();
  return {
    append: (input) => mem.append(input),
    readRun: async (_runId) => ok(issuedEntries),
    readAll: async () => ok(issuedEntries),
  };
}

function makeIssuedEntry(w: Warrant, extras: Record<string, unknown> = {}): LedgerEntry {
  return {
    runId: SESSION_ID,
    at: '2026-07-18T10:00:00.000Z',
    event: 'warrant.issued',
    principal: PRINCIPAL,
    payload: { requestId: CALL_ID, warrantId: w.id, warrant: w, ...extras },
    seq: 1,
    prevHash: '0'.repeat(64),
    hash: 'stub-hash',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// [CRITICAL] approval throw-safety
// ─────────────────────────────────────────────────────────────────────────────
describe('approval throw-safety', () => {
  const throwingFns: Array<[string, Partial<WarrantToolBinding<EmailInput>>]> = [
    ['toTarget', { toTarget: () => { throw new Error('toTarget exploded'); } }],
    ['toParams', { toParams: () => { throw new Error('toParams exploded'); } }],
    ['toContext', { toContext: () => { throw new Error('toContext exploded'); } }],
    ['toReviewTitle', { toReviewTitle: () => { throw new Error('toReviewTitle exploded'); } }],
    ['toReviewContent', { toReviewContent: () => { throw new Error('toReviewContent exploded'); } }],
  ];

  for (const [name, patch] of throwingFns) {
    it(`${name} throws → approval RESOLVES denied (no reject)`, async () => {
      // toReviewTitle/toReviewContent need human path → cold audience
      const b: WarrantToolBinding<EmailInput> = {
        ...binding,
        toContext: (_i) => ({ audience: 'cold' }),
        ...patch,
      };
      // toTarget throws before we reach the audience check, so it hits auto path for non-target fns
      // Use a separate fresh deps per case
      const deps = makeDeps();
      const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), b, deps);
      const ctx = makeApprovalCtx();
      await expect(tool.approval!(ctx)).resolves.toMatchObject({ type: 'denied' });
      const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
      expect(r.data!.map(e => e.event)).not.toContain('warrant.issued');
    });
  }

  it('deps.now() returns new Date(NaN) → approval RESOLVES denied (not reject)', async () => {
    const deps = makeDeps({ now: () => new Date(NaN) });
    const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), binding, deps);
    const ctx = makeApprovalCtx();
    await expect(tool.approval!(ctx)).resolves.toMatchObject({ type: 'denied' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// concurrency / cross-authorization
// ─────────────────────────────────────────────────────────────────────────────
describe('concurrency / cross-authorization', () => {
  it('callId-A execute succeeds with inputA; callId-B input used for callId-A → params_mismatch', async () => {
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'ok' }));
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    const inputA: EmailInput = { to: 'user@corp.com', subject: 'A', body: 'A body' };
    const inputB: EmailInput = { to: 'other@corp.com', subject: 'B', body: 'B body' };

    // Approve both
    await tool.approval!(makeApprovalCtx({ callId: 'call-A', toolInput: inputA }));
    await tool.approval!(makeApprovalCtx({ callId: 'call-B', toolInput: inputB }));

    // call-A executes with inputA → OK
    await tool.execute(inputA, makeToolCtx({ callId: 'call-A' }));
    expect(sideEffect).toHaveBeenCalledWith(inputA);

    // call-B executes with inputA (wrong!) → params_mismatch
    await expect(tool.execute(inputA, makeToolCtx({ callId: 'call-B' }))).rejects.toThrow('params_mismatch');

    // call-A cannot be re-executed with inputB (wrong params, also nonce_spent)
    await expect(tool.execute(inputB, makeToolCtx({ callId: 'call-A' }))).rejects.toThrow();

    // Two distinct action.executed nonces
    const all = await (deps.ledger as MemoryLedger).readAll();
    const executed = all.data!.filter(e => e.event === 'action.executed');
    expect(executed).toHaveLength(1); // only call-A succeeded
    const nonces = executed.map(e => (e.payload as Record<string, unknown>)['nonce'] as string);
    expect(new Set(nonces).size).toBe(nonces.length); // all distinct
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// concurrent TOCTOU replay
// ─────────────────────────────────────────────────────────────────────────────
describe('concurrent TOCTOU replay', () => {
  it('two concurrent executes: exactly one fulfils, one rejects nonce_spent, side-effect once', async () => {
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'toctou' }));
    const deps = makeDeps();
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);
    const emailInput: EmailInput = { to: 'user@example.com', subject: 'TOCTOU', body: 'Body' };

    await tool.approval!(makeApprovalCtx({ toolInput: emailInput }));

    const ctx = makeToolCtx();
    const [r1, r2] = await Promise.allSettled([
      tool.execute(emailInput, ctx),
      tool.execute(emailInput, ctx),
    ]);

    const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected = [r1, r2].filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejErr = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejErr.message).toMatch(/execute_nonce_spent/);
    expect(sideEffect).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ledger tamper
// ─────────────────────────────────────────────────────────────────────────────
describe('ledger tamper', () => {
  it('mutated warrant.signature → rejects invalid_signature or malformed_warrant', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const w = buildRealWarrant();
    const tampered: Warrant = { ...w, signature: 'ff'.repeat(64) };
    const stub = makeStubLedger([makeIssuedEntry(tampered)]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    const ctx = makeToolCtx();
    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, ctx))
      .rejects.toThrow(/warrant_invalid_signature|warrant_malformed_warrant/);
    expect(sideEffect).not.toHaveBeenCalled();

    // No action.executed appended to the underlying real ledger
    const mem = new MemoryLedger(); // stub uses a fresh internal MemoryLedger
    const all = await stub.readAll();
    expect(all.data!.map(e => e.event)).not.toContain('action.executed');
  });

  it('mutated warrant.action.target → rejects (signed field)', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const w = buildRealWarrant();
    const tampered: Warrant = { ...w, action: { ...w.action, target: 'evil@example.com' } };
    const stub = makeStubLedger([makeIssuedEntry(tampered)]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, makeToolCtx()))
      .rejects.toThrow(/warrant_invalid_signature/);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('mutated warrant.action.paramsHash → rejects (signed field)', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const w = buildRealWarrant();
    const tampered: Warrant = { ...w, action: { ...w.action, paramsHash: 'aa'.repeat(32) } };
    const stub = makeStubLedger([makeIssuedEntry(tampered)]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, makeToolCtx()))
      .rejects.toThrow(/warrant_invalid_signature/);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// authorized branch (ledger-wins + tamper)
// ─────────────────────────────────────────────────────────────────────────────
describe('authorized branch (ledger-wins)', () => {
  it('payload.authorized=X → side-effect receives X even when execute() gets different input', async () => {
    const sideEffect = vi.fn((_i: EmailInput) => ({ messageId: 'auth' }));
    const authorizedParams: EmailInput = { to: 'approved@corp.com', subject: 'Authorized', body: 'Approved body' };
    const w = buildRealWarrant({ params: authorizedParams });
    const stub = makeStubLedger([makeIssuedEntry(w, { authorized: authorizedParams })]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    // Pass different input: ledger-authorized params should win
    const differentInput: EmailInput = { to: 'other@example.com', subject: 'Different', body: 'Different body' };
    const out = await tool.execute(differentInput, makeToolCtx());
    expect(out).toEqual({ messageId: 'auth' });
    expect(sideEffect).toHaveBeenCalledWith(authorizedParams);
  });

  it('payload.authorized=Y where paramsHash(Y) ≠ w.paramsHash → params_mismatch', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const originalParams: EmailInput = { to: 'user@example.com', subject: 'Test', body: 'Body' };
    const w = buildRealWarrant({ params: originalParams });
    // Tampered authorized payload: paramsHash won't match
    const tamperedAuthorized: EmailInput = { to: 'evil@example.com', subject: 'Hacked', body: 'Evil' };
    const stub = makeStubLedger([makeIssuedEntry(w, { authorized: tamperedAuthorized })]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute(originalParams, makeToolCtx())).rejects.toThrow('params_mismatch');
    expect(sideEffect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runId mismatch [MED fix #2]
// ─────────────────────────────────────────────────────────────────────────────
describe('runId mismatch', () => {
  it('warrant.runId !== ctx.session.id → rejects warrant_run_mismatch', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    // Issue warrant under 'other-run', but execute with session.id='session-1'
    const w = buildRealWarrant({ runId: 'other-run' });
    const stub = makeStubLedger([makeIssuedEntry(w)]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, makeToolCtx()))
      .rejects.toThrow(/warrant_run_mismatch/);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// target mismatch (auto path) [MED fix #3]
// ─────────────────────────────────────────────────────────────────────────────
describe('target mismatch (auto path)', () => {
  it('w.action.target ≠ binding.toTarget(input) → rejects target_mismatch', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    // Use a binding where toParams does NOT include the target field, so params hash
    // can match while target diverges
    type BodyOnlyParams = { body: string };
    const paramsOnlyBinding: WarrantToolBinding<EmailInput, BodyOnlyParams> = {
      ...binding,
      toParams: (_i) => ({ body: 'fixed-body' }), // no target in params
      toTarget: (i) => i.to,
    };
    // Issue a warrant with target='signed-target@example.com' and params={body:'fixed-body'}
    const w = buildRealWarrant({
      target: 'signed-target@example.com',
      params: { body: 'fixed-body' },
    });
    const stub = makeStubLedger([makeIssuedEntry(w)]);
    const deps = makeDeps({ ledger: stub });
    const tool = withWarrant(makePlainTool<BodyOnlyParams>(sideEffect), paramsOnlyBinding, deps);

    // Execute with input whose toTarget gives 'different@example.com'
    const input: EmailInput = { to: 'different@example.com', subject: 'Test', body: 'fixed-body' };
    await expect(tool.execute(input, makeToolCtx())).rejects.toThrow(/target_mismatch/);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// malformed warrant payload
// ─────────────────────────────────────────────────────────────────────────────
describe('malformed warrant payload', () => {
  it('payload has no warrant key → rejects warrant_malformed_warrant', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const entry: LedgerEntry = {
      runId: SESSION_ID, at: '2026-07-18T10:00:00.000Z', event: 'warrant.issued',
      principal: PRINCIPAL, payload: { requestId: CALL_ID },
      seq: 1, prevHash: '0'.repeat(64), hash: 'stub',
    };
    const deps = makeDeps({ ledger: makeStubLedger([entry]) });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, makeToolCtx()))
      .rejects.toThrow(/warrant_malformed_warrant/);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('payload.warrant is a string "garbage" → rejects', async () => {
    const sideEffect = vi.fn(() => ({ messageId: 'x' }));
    const entry: LedgerEntry = {
      runId: SESSION_ID, at: '2026-07-18T10:00:00.000Z', event: 'warrant.issued',
      principal: PRINCIPAL, payload: { requestId: CALL_ID, warrant: 'garbage' },
      seq: 1, prevHash: '0'.repeat(64), hash: 'stub',
    };
    const deps = makeDeps({ ledger: makeStubLedger([entry]) });
    const tool = withWarrant(makePlainTool(sideEffect), binding, deps);

    await expect(tool.execute({ to: 'user@example.com', subject: 'Test', body: 'Body' }, makeToolCtx()))
      .rejects.toThrow();
    expect(sideEffect).not.toHaveBeenCalled();
  });
});
