// The end-to-end form of design spec section 8 step 3, driven through the real withWarrant wrapper
// rather than through a hand-built ledger: approval mints, execute spends the nonce and enqueues,
// the drainer re-verifies and sends. The property under test is that the object the SENDER receives
// still hashes to the paramsHash the WARRANT was signed over, across every path a real run takes,
// including the human-edit path where the authorized bytes are not the bytes the model proposed.
import { describe, it, expect } from 'vitest';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { paramsHash } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { ReviewContent } from '@idriszade/warrant-gatewerk';
import { MemoryOutbox, drainOutbox, resumeByPoll } from '@idriszade/warrant-eve';
import type { Sender } from '@idriszade/warrant-eve';
import { buildDeps } from '../src/build.js';
import type { DemoInput } from '../src/build.js';
import { buildGovernedSendEmailTool } from '../src/governed-send-email.js';

const RUN_ID = 'governed-outbox-run';

// What the simulated human edits. Stated by the demo, which owns the email shape,
// rather than by SimGate, which does not know content has a `body`.
const editBody = (c: ReviewContent): ReviewContent => ({
  ...c, body: `${String(c['body'])}\n\n[edited in review]`,
});

function approvalCtx(callId: string, toolInput: DemoInput): ApprovalContext<DemoInput> {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(), callId, toolName: 'send_email', toolInput,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<DemoInput>;
}

function toolCtx(callId: string): ToolContext {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId, toolName: 'send_email', abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
    getToken: async () => { throw new Error('n/a'); },
    requireAuth: () => { throw new Error('n/a') as never; },
  } satisfies ToolContext;
}

function capturingSender() {
  const seen: unknown[] = [];
  const sender: Sender<unknown> = {
    async send(params) { seen.push(params); return { data: { messageId: `<m${seen.length}>` }, error: null }; },
  };
  return { sender, seen };
}

function harness(gate = new SimGate([])) {
  const ledger = new MemoryLedger();
  let tick = 0;
  const deps = buildDeps({
    ledger, gate,
    now: () => new Date(new Date('2026-07-18T12:00:00.000Z').getTime() + tick++ * 1000),
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
  const outbox = new MemoryOutbox();
  return { ledger, deps, outbox, tool: buildGovernedSendEmailTool(deps, outbox) };
}

function issuedWarrant(entries: { event: string; payload: unknown }[], requestId: string) {
  const e = entries.find((x) => x.event === 'warrant.issued'
    && (x.payload as Record<string, unknown>)['requestId'] === requestId);
  return (e!.payload as Record<string, unknown>)['warrant'] as { action: { paramsHash: string } };
}

describe('buildGovernedSendEmailTool', () => {
  it('enqueues instead of sending, and the row hashes to the signed paramsHash (auto path)', async () => {
    const { ledger, deps, outbox, tool } = harness();
    const input: DemoInput = { to: 'user@corp.com', subject: 'S', body: 'B', audience: 'known' };

    expect(await tool.approval!(approvalCtx('call-1', input))).toBe('approved');
    const out = await tool.execute(input, toolCtx('call-1'));
    expect(out.messageId).toBe('queued:call-1');

    const pending = await outbox.listPending();
    expect(pending.data).toHaveLength(1);
    const row = pending.data![0]!;
    expect(row).toMatchObject({ requestId: 'call-1', runId: RUN_ID });

    const w = issuedWarrant((await ledger.readRun(RUN_ID)).data!, 'call-1');
    expect(paramsHash(row.params)).toBe(w.action.paramsHash);

    // audience is context, not params. If the row carried it the hash above would already have
    // failed, but assert it directly so the reason is legible when it does.
    expect(row.params).not.toHaveProperty('audience');
  });

  it('the sender receives an object that still hashes to the warrant paramsHash', async () => {
    const { ledger, deps, outbox, tool } = harness();
    const input: DemoInput = { to: 'user@corp.com', subject: 'S', body: 'B', audience: 'known' };
    await tool.approval!(approvalCtx('call-1', input));
    await tool.execute(input, toolCtx('call-1'));

    const { sender, seen } = capturingSender();
    const drained = await drainOutbox(
      { ledger, publicKeyHex: deps.publicKeyHex, now: deps.now, principal: { kind: 'agent', id: 'x' } },
      { outbox, sender },
    );
    expect(drained.data).toEqual([{ requestId: 'call-1', status: 'sent', messageId: '<m1>' }]);

    const w = issuedWarrant((await ledger.readRun(RUN_ID)).data!, 'call-1');
    expect(seen).toHaveLength(1);
    expect(paramsHash(seen[0])).toBe(w.action.paramsHash);
  });

  // The human-edit path is where a re-render would actually diverge: the bytes a human approved
  // are not the bytes the model proposed, and `execute` passes the AUTHORIZED object through.
  it('carries the EDITED bytes through to the sender, still matching the signed hash', async () => {
    const { ledger, deps, outbox, tool } = harness(new SimGate(['edit'], { editContent: editBody }));
    const input: DemoInput = { to: 'prospect@corp.com', subject: 'Intro', body: 'Draft', audience: 'cold' };

    expect(await tool.approval!(approvalCtx('call-2', input))).toBe('user-approval');
    const entries = (await ledger.readRun(RUN_ID)).data!;
    const reviewId = (entries.find((e) => e.event === 'review.submitted')!
      .payload as Record<string, unknown>)['reviewId'] as string;
    const resumed = await resumeByPoll(deps, { reviewId, runId: RUN_ID, deliver: async () => {} });
    expect(resumed.data).toBe('issued');

    await tool.execute(input, toolCtx('call-2'));
    const { sender, seen } = capturingSender();
    await drainOutbox(
      { ledger, publicKeyHex: deps.publicKeyHex, now: deps.now, principal: { kind: 'agent', id: 'x' } },
      { outbox, sender },
    );

    const w = issuedWarrant((await ledger.readRun(RUN_ID)).data!, 'call-2');
    expect(seen).toHaveLength(1);
    expect(paramsHash(seen[0])).toBe(w.action.paramsHash);
    // SimGate's edit path changes the body, so this also proves the assertion above is not
    // trivially satisfied by the drainer simply echoing whatever execute happened to pass.
    expect((seen[0] as { body: string }).body).not.toBe('Draft');
  });

  it('a policy denial never reaches the outbox', async () => {
    const { outbox, tool } = harness();
    const input: DemoInput = { to: 'someone@agency.gov', subject: 'S', body: 'B', audience: 'known' };
    const verdict = await tool.approval!(approvalCtx('call-3', input));
    expect(verdict).toMatchObject({ type: 'denied' });
    await expect(tool.execute(input, toolCtx('call-3'))).rejects.toThrow('warrant_missing');
    expect((await outbox.listPending()).data).toHaveLength(0);
  });

  it('an outbox failure throws out of execute, leaving the nonce spent and nothing sent', async () => {
    const { ledger, deps, tool: _t } = harness();
    const failing = {
      enqueue: async () => ({ data: null, error: { type: 'transient' as const, code: 'db_error', message: 'down' } }),
      listPending: async () => ({ data: [], error: null }),
      retire: async () => ({ data: undefined, error: null }),
    };
    const tool = buildGovernedSendEmailTool(deps, failing);
    const input: DemoInput = { to: 'user@corp.com', subject: 'S', body: 'B', audience: 'known' };
    await tool.approval!(approvalCtx('call-4', input));
    await expect(tool.execute(input, toolCtx('call-4'))).rejects.toThrow('outbox_db_error');

    // The nonce IS spent: execute appends action.executed before calling the tool body. That is the
    // fail-closed direction. The run is stuck, not silently sent.
    const entries = (await ledger.readRun(RUN_ID)).data!;
    expect(entries.filter((e) => e.event === 'action.executed')).toHaveLength(1);
    await expect(tool.execute(input, toolCtx('call-4'))).rejects.toThrow(/nonce_spent|execute_/);
  });
});
