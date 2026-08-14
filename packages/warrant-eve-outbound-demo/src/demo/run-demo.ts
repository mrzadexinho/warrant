#!/usr/bin/env node
// run-demo.ts, the `pnpm demo` entry point: a fully offline, deterministic walk through one
// complete warrant lifecycle. This is packaging, not design: every call below reuses the exact
// public APIs `tests/e2e.test.ts` drives (buildDeps/buildSendEmailTool, MemoryLedger, SimGate,
// resumeByPoll, exportLedgerJson, verifyChain, replayRun, renderProofMarkdown). No network, no
// Postgres, no env vars: MemoryLedger and SimGate are both in-memory, and the clock and id
// generator are both fixed functions rather than wall-clock/`Math.random()`, so the run (and the
// proof it writes) does not depend on when or how many times it is invoked.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { ReviewContent } from '@idriszade/warrant-gatewerk';
import { resumeByPoll, exportLedgerJson } from '@idriszade/warrant-eve';
import { verifyChain, replayRun, renderProofMarkdown } from '@idriszade/warrant-verify';
import { buildDeps, buildSendEmailTool } from '../build.js';
import type { DemoInput, EmailContent } from '../build.js';

const RUN_ID = 'demo-run-1';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../out');
const OUT_PATH = join(OUT_DIR, 'proof.md');

// What the simulated reviewer changes. Owned here, same as in the e2e test: SimGate is
// domain-blind and will not invent an edit shape for a `ReviewContent` it does not know.
const editBody = (c: ReviewContent): ReviewContent => ({
  ...c, body: `${String(c['body'])}\n\n[edited in review]`,
});

function makeApprovalCtx(callId: string, toolInput: DemoInput): ApprovalContext<DemoInput> {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId,
    toolName: 'send_email',
    toolInput,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<DemoInput>;
}

function makeToolCtx(callId: string): ToolContext {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    callId,
    toolName: 'send_email',
    abortSignal: new AbortController().signal,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
    getToken: async () => { throw new Error('n/a'); },
    requireAuth: () => { throw new Error('n/a') as never; },
  } satisfies ToolContext;
}

function say(step: string, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${step}] ${msg}`);
}

async function main(): Promise<void> {
  const outbox: EmailContent[] = [];
  const ledger = new MemoryLedger();
  // Fixed clock, no `Date.now()`: identical wall-clock content on every run.
  let nowTick = 0;
  const deps = buildDeps({
    ledger,
    gate: new SimGate(['edit'], { editContent: editBody }),
    now: () => new Date(new Date('2026-08-13T09:00:00.000Z').getTime() + nowTick++ * 1000),
    newId: (() => { let t = 0; return () => `demo-${++t}`; })(),
  });
  const tool = buildSendEmailTool(deps, outbox);

  // ── 1. Agent proposes an action ─────────────────────────────────────────
  const input: DemoInput = {
    to: 'prospect@corp.com', subject: 'Intro', body: 'Original outreach body', audience: 'cold',
  };
  say('1/7', `Agent proposes send_email → ${input.to} (audience: ${input.audience})`);

  // ── 2. Policy evaluates → verdict human ─────────────────────────────────
  const approval = await tool.approval!(makeApprovalCtx('demo-call-1', input));
  if (approval !== 'user-approval') {
    throw new Error(`expected policy to route audience:cold to human review, got ${JSON.stringify(approval)}`);
  }
  say('2/7', 'Policy evaluates → verdict: human (audience:cold routes to review)');

  // ── 3. SimGate approves WITH an injected edit ───────────────────────────
  const run = await ledger.readRun(RUN_ID);
  const reviewEvent = run.data!.find((e) => e.event === 'review.submitted'
    && (e.payload as Record<string, unknown>)['requestId'] === 'demo-call-1');
  const reviewId = (reviewEvent!.payload as Record<string, unknown>)['reviewId'] as string;
  say('3/7', 'SimGate: reviewer edits the draft before approving (appends "[edited in review]")');

  // ── 4. Human warrant minted from the attested decision ──────────────────
  const resume = await resumeByPoll(deps, { reviewId, runId: RUN_ID, deliver: async () => {} });
  if (resume.data !== 'issued') {
    throw new Error(`expected resumeByPoll to issue a warrant, got ${JSON.stringify(resume)}`);
  }
  say('4/7', `Human warrant minted (reviewId: ${reviewId})`);

  // ── 5. Guard verifies, spends the nonce, executes against a recording actuator ──
  const result = await tool.execute(input, makeToolCtx('demo-call-1'));
  say('5/7', `Guard verified warrant + spent nonce → executed against in-memory outbox (messageId: ${result.messageId})`);

  // ── 6. Outcome recorded ──────────────────────────────────────────────────
  const editedBody = outbox[0]?.body ?? '';
  say('6/7', `Outcome recorded: 1 email sent, body carries the reviewer's edit: ${editedBody.includes('[edited in review]')}`);

  // ── 7. Verify the ledger chain and write the proof ──────────────────────
  await mkdir(OUT_DIR, { recursive: true });
  const exported = await exportLedgerJson(ledger, join(OUT_DIR, 'ledger.json'));
  if (exported.error) throw new Error(`exportLedgerJson failed: ${exported.error.message}`);
  const rawJson = await readFile(join(OUT_DIR, 'ledger.json'), 'utf8');
  const entries = JSON.parse(rawJson) as Parameters<typeof verifyChain>[0];

  const chainResult = verifyChain(entries);
  if (chainResult.error) throw new Error(`verifyChain failed: ${chainResult.error.message}`);

  const fixedNow = () => new Date('2026-08-13T09:30:00.000Z');
  const report = replayRun(entries, RUN_ID, fixedNow);
  if (report.error) throw new Error(`replayRun failed: ${report.error.message}`);

  const md = [
    renderProofMarkdown(report.data!),
    '## Demo Summary', '',
    '- **verdict path:** human (audience:cold)',
    `- **edit applied:** ${editedBody.includes('[edited in review]') ? 'yes: "[edited in review]" appended to body' : 'no'}`,
    `- **chain verification:** ${chainResult.error === null ? '✓ verified' : '✗ failed'}`,
    `- **ledger entry count:** ${entries.length}`,
    '',
  ].join('\n');
  await writeFile(OUT_PATH, md);
  say('7/7', `Chain verified (${entries.length} entries) → wrote ${OUT_PATH}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
