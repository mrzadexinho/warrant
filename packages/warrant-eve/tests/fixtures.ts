// tests/fixtures.ts: shared resumeByPoll test fixtures, extracted from resume.test.ts so that
// resume.test.ts, resume-claim.test.ts, and resume-orphan.test.ts can all build on the same
// policy/deps/binding setup without duplicating it. Pure extraction: no behavior change.
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { generateKeyPair } from '@idriszade/warrant-core';
import { loadPolicy } from '@idriszade/warrant-policy';
import { MemoryParkStore } from '../src/park-store.js';
import { withWarrant } from '../src/index.js';
import type { WarrantEveDeps, WarrantToolBinding, PlainTool } from '../src/index.js';

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

export const KEYS = generateKeyPair('11'.repeat(32));
export const SESSION_ID = 'session-1';
export const CALL_ID = 'call-1';
export const PRINCIPAL = { kind: 'agent' as const, id: 'agent-outbound' };

export type EmailInput = { to: string; subject: string; body: string };
export type EmailOutput = { messageId: string };

export function makeApprovalCtx(opts: { callId?: string; toolInput?: EmailInput } = {}): ApprovalContext<EmailInput> {
  return {
    session: { id: SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId: opts.callId ?? CALL_ID,
    toolName: 'send_email',
    toolInput: opts.toolInput ?? { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' },
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<EmailInput>;
}

export function makeToolCtx(opts: { callId?: string } = {}): ToolContext {
  return {
    session: { id: SESSION_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId: opts.callId ?? CALL_ID,
    toolName: 'send_email',
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
    getToken: async () => { throw new Error('n/a'); },
    requireAuth: () => { throw new Error('n/a') as never; },
  } satisfies ToolContext;
}

export function makeDeps(overrides: Partial<WarrantEveDeps> = {}): WarrantEveDeps {
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

export const coldBinding: WarrantToolBinding<EmailInput> = {
  actionKind: 'send_email',
  principal: PRINCIPAL,
  toTarget: (i) => i.to,
  toParams: (i) => ({ to: i.to, subject: i.subject, body: i.body }),
  toContext: (_i) => ({ audience: 'cold' }),
  toReviewTitle: (i) => `Send email to ${i.to}`,
  toReviewContent: (i) => ({ subject: i.subject, body: i.body, to: i.to }),
};

// Generic in the params the handler receives, defaulting to EmailInput: a faithful binding hands
// the handler its own input, and the adversarial bindings that do not now have to say so.
export function makePlainTool<P = EmailInput>(fn: (params: P) => EmailOutput): PlainTool<P, EmailOutput> {
  return {
    description: 'Send an email',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    execute: (params) => fn(params),
  };
}

export async function seedReview(deps: WarrantEveDeps, input: EmailInput): Promise<string> {
  const tool = withWarrant(makePlainTool(() => ({ messageId: 'x' })), coldBinding, deps);
  const result = await tool.approval!(makeApprovalCtx({ toolInput: input }));
  if (result !== 'user-approval') throw new Error('Expected user-approval, got: ' + String(result));
  const r = await (deps.ledger as MemoryLedger).readRun(SESSION_ID);
  const entry = r.data!.find(e => e.event === 'review.submitted');
  if (!entry) throw new Error('No review.submitted in ledger');
  return (entry.payload as Record<string, unknown>)['reviewId'] as string;
}
