#!/usr/bin/env node
// run-demo-human.ts, the `pnpm demo:human` entry point: the same warrant lifecycle as
// `pnpm demo`, with the one substitution that is the whole point: the simulated reviewer is
// replaced by a REAL person deciding in a locally running Gatewerk. Everything else is the
// same public surface the offline demo drives (buildDeps/buildSendEmailTool, MemoryLedger,
// resumeByPoll, exportLedgerJson, verifyChain, replayRun, renderProofMarkdown).
//
// Two deliberate differences from the offline demo:
// - Real clock and random ids. The offline demo pins both so its proof is byte-identical
//   across runs; this run contains a live human decision, so determinism is neither possible
//   nor claimed.
// - The gate polls instead of listening. Gatewerk validates callback_url at review creation
//   and rejects localhost and private addresses unconditionally, so a fully local run cannot
//   receive the webhook. The webhook is a doorbell, not the source of truth: resumeByPoll
//   re-fetches the decision from Gatewerk either way, and warrant refuses to mint from any
//   decision that does not carry the review station's attestation of an authenticated human
//   session (a `reviewer:` prefix in last_action_by). The callback URL sent is therefore a
//   syntactically valid public placeholder that nothing answers.
//
// Configuration (env, read only here in the composition root):
//   GATEWERK_API_KEY        required, the seeded key from `docker compose logs gatewerk-seed`
//   GATEWERK_BASE_URL       default http://localhost:3100
//   GATEWERK_TEMPLATE_SLUG  default proposal-review (seeded by Gatewerk's quickstart)
//   GATEWERK_CALLBACK_URL   default https://example.com/warrant-demo-callback (see above)
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { resumeByPoll, exportLedgerJson } from '@idriszade/warrant-eve';
import { verifyChain, replayRun, renderProofMarkdown } from '@idriszade/warrant-verify';
import { buildDeps, buildSendEmailTool } from '../build.js';
import type { DemoInput, EmailContent } from '../build.js';

const RUN_ID = `human-demo-${randomUUID()}`;
const CALL_ID = `${RUN_ID}-call-1`;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../out');
const OUT_PATH = join(OUT_DIR, 'proof-human.md');
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

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
  const apiKey = process.env['GATEWERK_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'GATEWERK_API_KEY is not set. Run Gatewerk\'s quickstart, then copy the seeded key: ' +
      'docker compose logs gatewerk-seed',
    );
  }
  const baseUrl = process.env['GATEWERK_BASE_URL'] ?? 'http://localhost:3100';
  const templateSlug = process.env['GATEWERK_TEMPLATE_SLUG'] ?? 'proposal-review';
  const callbackUrl = process.env['GATEWERK_CALLBACK_URL'] ?? 'https://example.com/warrant-demo-callback';

  const outbox: EmailContent[] = [];
  const ledger = new MemoryLedger();
  const deps = buildDeps({
    ledger,
    gate: new GatewerkGate({ baseUrl, apiKey, callbackUrl, templateSlug }),
    now: () => new Date(),
    newId: () => randomUUID(),
  });
  const tool = buildSendEmailTool(deps, outbox);

  // ── 1. Agent proposes an action ─────────────────────────────────────────
  const input: DemoInput = {
    to: 'prospect@corp.com', subject: 'Intro', body: 'Original outreach body', audience: 'cold',
  };
  say('1/7', `Agent proposes send_email -> ${input.to} (audience: ${input.audience})`);

  // ── 2. Policy evaluates -> verdict human; the review is created in Gatewerk ──
  const approval = await tool.approval!(makeApprovalCtx(CALL_ID, input));
  if (approval !== 'user-approval') {
    throw new Error(`expected policy to route audience:cold to human review, got ${JSON.stringify(approval)}`);
  }
  const run = await ledger.readRun(RUN_ID);
  const reviewEvent = run.data!.find((e) => e.event === 'review.submitted'
    && (e.payload as Record<string, unknown>)['requestId'] === CALL_ID);
  const reviewId = (reviewEvent!.payload as Record<string, unknown>)['reviewId'] as string;
  say('2/7', `Policy evaluates -> verdict: human. Review created in Gatewerk (${reviewId})`);

  // ── 3. A real person decides ────────────────────────────────────────────
  say('3/7', 'Waiting for a HUMAN decision. Open the Gatewerk dashboard, find the pending');
  say('3/7', `review, and approve (or deny, or approve with an edit): ${baseUrl.replace(':3100', ':8880')}`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let outcome: 'issued' | 'denied' | 'pending' = 'pending';
  while (outcome === 'pending') {
    if (Date.now() > deadline) {
      throw new Error(`no decision after ${String(POLL_TIMEOUT_MS / 60000)} minutes; review ${reviewId} is still pending`);
    }
    await sleep(POLL_INTERVAL_MS);
    const polled = await resumeByPoll(deps, { reviewId, runId: RUN_ID, deliver: async () => {} });
    if (polled.error) throw new Error(`resumeByPoll failed: ${polled.error.message}`);
    outcome = polled.data!;
  }
  if (outcome === 'denied') {
    say('4/7', 'The reviewer DENIED. No warrant exists, nothing may execute; that refusal is');
    say('4/7', 'itself in the ledger. Denial is a correct ending for this demo, not a failure.');
  } else {
    // ── 4. Human warrant minted from the attested decision ────────────────
    say('4/7', `Human warrant minted from the attested decision (reviewId: ${reviewId})`);

    // ── 5. Guard verifies, spends the nonce, executes ─────────────────────
    const result = await tool.execute(input, makeToolCtx(CALL_ID));
    say('5/7', `Guard verified warrant + spent nonce -> executed against in-memory outbox (messageId: ${result.messageId})`);

    // ── 6. Outcome recorded ───────────────────────────────────────────────
    const sentBody = outbox[0]?.body ?? '';
    const edited = sentBody !== input.body;
    say('6/7', `Outcome recorded: 1 email in the outbox; reviewer's edit applied: ${String(edited)}`);
  }

  // ── 7. Verify the ledger chain and write the proof ──────────────────────
  await mkdir(OUT_DIR, { recursive: true });
  const exported = await exportLedgerJson(ledger, join(OUT_DIR, 'ledger-human.json'));
  if (exported.error) throw new Error(`exportLedgerJson failed: ${exported.error.message}`);
  const rawJson = await readFile(join(OUT_DIR, 'ledger-human.json'), 'utf8');
  const entries = JSON.parse(rawJson) as Parameters<typeof verifyChain>[0];

  const chainResult = verifyChain(entries);
  if (chainResult.error) throw new Error(`verifyChain failed: ${chainResult.error.message}`);

  const report = replayRun(entries, RUN_ID, () => new Date());
  if (report.error) throw new Error(`replayRun failed: ${report.error.message}`);

  const md = [
    renderProofMarkdown(report.data!),
    '## Human Demo Summary', '',
    `- **verdict path:** human, decided by a real reviewer in Gatewerk (review ${reviewId})`,
    `- **outcome:** ${outcome}`,
    `- **chain verification:** ${chainResult.error === null ? 'verified' : 'FAILED'}`,
    `- **ledger entry count:** ${entries.length}`,
    '',
    'The `warrant.issued` entry (if present) carries the decision attestation: warrant',
    'refuses to mint unless Gatewerk attests the decision came from an authenticated human',
    'reviewer session. See docs/guides/human-attested-run.md for what this proves and what',
    'it does not.',
    '',
  ].join('\n');
  await writeFile(OUT_PATH, md);
  say('7/7', `Chain verified (${entries.length} entries) -> wrote ${OUT_PATH}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
