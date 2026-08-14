/**
 * live-e2e.test.ts: Milestone B local end-to-end proof (Task 12, design spec section 12.3 "the
 * live run is the final test": LOCAL half only; real Gatewerk credentials, real SMTP, and the
 * deployed ceremony are Pass 2 and deliberately absent here). Drives every real Milestone B code
 * path with no network and no model: a governed run parks on a real policy `human` verdict via
 * the real withWarrant approval, the real park observer (src/park-observer.ts) records the park
 * from a real-shaped `input.requested` event, a properly HMAC-signed Gatewerk webhook is handled
 * by the real handleGatewerkWebhook (src/webhook-handler.ts), the decision is fetched through the
 * real GatewerkGate (an injected fetchImpl stands in for the network only, per master C6/C7), the
 * real resumeByPoll claims + re-runs policy + mints, execute spends the nonce, and the
 * certificate is produced by the BUILT warrant-verify bin (dist/cli.js via `node`, never tsx).
 * Every certificate assertion is made against the file ON DISK, not an in-memory object.
 * Sections: fixtures/helpers (~L20-70) - beforeAll builds the verifier bin (~L75) - the proof
 * (~L80-end).
 * Companion: tests/e2e.test.ts (Milestone A, SimGate-driven, no webhook/park/CLI involved).
 * Sibling: tests/live-e2e-edits.test.ts (approve-with-edits: same real code paths, asserts the
 * outbox carries the human's CORRECTED recipient, not the original).
 * Env-gated real-runtime smoke lives in tests/live-e2e-smoke.test.ts (separate file).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import type { ApprovalContext, ToolContext } from 'eve/tools';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { MemoryParkStore, exportLedgerJson } from '@idriszade/warrant-eve';
import { verifyChain, replayRun, IN_TOTO_STATEMENT_TYPE } from '@idriszade/warrant-verify';
import { buildDeps, buildSendEmailTool } from '../src/build.js';
import type { DemoInput, EmailContent } from '../src/build.js';
import { handleGatewerkWebhook } from '../src/webhook-handler.js';
import { handleParkObserverEvent } from '../src/park-observer.js';
import type { ParkObserverEvent } from '../src/park-observer.js';

const RUN_ID = 'live-e2e-run-1';
const WEBHOOK_SECRET = 'live-e2e-webhook-secret';
const NOW = () => new Date('2026-07-27T09:00:00.000Z');

// Recorded live-schema fixtures (shape locked by 00-master.md C6/C7): no network. `id` is the
// only field GatewerkGate#submit reads from the submit response.
const SUBMIT_FIXTURE = { id: 'review-live-001' };
// A valid HUMAN decision. `last_action_by:'reviewer:...'` is what mapReviewDecision's allowlist
// requires to mint at all (design spec section 2.2 / 7.2): without it the decision is refused
// with human_attestation_missing no matter what `decided_by` says.
const DECISION_FIXTURE = {
  id: 'review-live-001',
  status: 'decided',
  decision: 'approved',
  decided_by: 'alice@corp.example',
  last_action_by: 'reviewer:alice@corp.example',
};

function makeFixtureFetch(): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    const body = calls === 1 ? SUBMIT_FIXTURE : DECISION_FIXTURE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function signStandardWebhook(rawBody: string, secret: string, now: () => Date): Headers {
  const id = 'live-msg-1';
  const ts = Math.floor(now().getTime() / 1000).toString();
  const sig = createHmac('sha256', secret).update(`${id}\n${ts}\n${rawBody}`).digest('base64');
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` });
}

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

const VERIFY_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../warrant-verify');
const PORTFOLIO_ROOT = join(VERIFY_PKG_ROOT, '..', '..');
const CLI_DIST = join(VERIFY_PKG_ROOT, 'dist/cli.js');

describe('Milestone B local e2e proof (Task 12)', () => {
  beforeAll(() => {
    // The proof invokes the BUILT bin below (not tsx, not the library): build it here so this
    // file is a self-contained proof and does not silently pass by falling back to a stale dist.
    const build = spawnSync('pnpm', ['--filter', '@idriszade/warrant-verify', 'run', 'build'], {
      cwd: PORTFOLIO_ROOT, encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`warrant-verify build failed: ${build.stderr}`);
  }, 60_000);

  it('parks on human verdict, resumes via the real webhook control flow, executes, and produces a verifiable on-disk certificate', async () => {
    const outbox: EmailContent[] = [];
    const deps = buildDeps({
      ledger: new MemoryLedger(),
      gate: new GatewerkGate({
        baseUrl: 'https://gatewerk.example.test',
        apiKey: 'test-key',
        callbackUrl: 'https://agent.example.test/warrant/v1/gatewerk/review',
        templateSlug: 'warrant-outbound-email',
        fetchImpl: makeFixtureFetch(),
      }),
      parkStore: new MemoryParkStore(),
      now: NOW,
      newId: (() => { let t = 0; return () => `live-id-${++t}`; })(),
    });
    const tool = buildSendEmailTool(deps, outbox);

    // ── Step 1: the REAL withWarrant approval parks on a real policy `human` verdict ────────
    const input: DemoInput = { to: 'prospect@corp.com', subject: 'Intro', body: 'Hello', audience: 'cold' };
    const approval = await tool.approval!(makeApprovalCtx('call-1', input));
    expect(approval).toBe('user-approval');

    const run = await deps.ledger.readRun(RUN_ID);
    const reviewEntry = run.data!.find(e => e.event === 'review.submitted')!;
    const requestId = (reviewEntry.payload as Record<string, unknown>)['requestId'] as string;
    const reviewId = (reviewEntry.payload as Record<string, unknown>)['reviewId'] as string;
    expect(reviewId).toBe('review-live-001'); // GatewerkGate#submit: reviewId = json.id

    // ── Step 2: the REAL park observer records the park from a real-shaped input.requested ──
    const parkEvent: ParkObserverEvent = {
      type: 'input.requested',
      data: { requests: [{ requestId: 'eve-req-1', action: { callId: requestId } }] },
    };
    const observed = await handleParkObserverEvent(parkEvent, {
      ledger: deps.ledger, parkStore: deps.parkStore, runId: RUN_ID,
      continuationToken: 'cont-tok-1', now: NOW,
    });
    expect(observed.error).toBeNull();
    expect(observed.data).toBe('continue');
    const parked = await deps.parkStore.get(reviewId);
    expect(parked.data).toMatchObject({ callId: requestId, eveRequestId: 'eve-req-1' });

    // ── Step 3-5: a properly signed webhook, handled by the REAL handleGatewerkWebhook, which
    // internally calls the REAL GatewerkGate.fetchDecision (over the injected fetchImpl only)
    // and the REAL resumeByPoll (claim -> re-policy on final content -> mint) ─────────────────
    const rawBody = JSON.stringify({ type: 'review.decided', review_id: reviewId });
    const headers = signStandardWebhook(rawBody, WEBHOOK_SECRET, NOW);
    const delivered: Array<{ callId: string; outcome: 'approved' | 'denied' }> = [];
    const outcome = await handleGatewerkWebhook(deps, {
      rawBody, headers, secret: WEBHOOK_SECRET,
      deliver: async (rec, o) => { delivered.push({ callId: rec.callId, outcome: o }); },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body['outcome']).toBe('issued');
    expect(delivered).toEqual([{ callId: requestId, outcome: 'approved' }]);

    const afterResume = await deps.ledger.readRun(RUN_ID);
    const issuedEntry = afterResume.data!.find(e => e.event === 'warrant.issued')!;
    expect((issuedEntry.payload as Record<string, unknown>)['decidedBy']).toBe('alice@corp.example');

    // ── Step 6: execute spends the nonce, outbox gets exactly one entry ─────────────────────
    const out = await tool.execute(input, makeToolCtx('call-1'));
    expect(out.messageId).toMatch(/^sent-/);
    expect(outbox).toHaveLength(1);

    // ── Step 7: export, chain-verify, replay ────────────────────────────────────────────────
    const ledgerPath = join(tmpdir(), `live-e2e-ledger-${Date.now()}.json`);
    expect((await exportLedgerJson(deps.ledger, ledgerPath)).error).toBeNull();

    const all = await deps.ledger.readAll();
    expect(verifyChain(all.data!).error).toBeNull();
    const chainHead = all.data![all.data!.length - 1]!.hash;

    const report = replayRun(all.data!, RUN_ID, () => new Date('2026-07-27T09:30:00.000Z'));
    expect(report.error).toBeNull();
    // trajectoryProven: 0, no producer upstream attests one in this run, so this is an
    // action-only proof and says so. contextBinding is asserted because this run goes through
    // the real approval path and the real webhook resume.
    expect(report.data!.counts).toEqual({ requested: 1, auto: 0, human: 1, denied: 0, executed: 1, attested: 0, trajectoryProven: 0 });
    expect(report.data!.journeys[0]!.contextBinding).toBe('bound');
    expect(report.data!.violations).toEqual([]);

    // ── Step 7 (cont.): sign + verify an on-disk in-toto/DSSE certificate via the BUILT bin ──
    const certPath = join(tmpdir(), `live-e2e-cert-${Date.now()}.json`);
    const sign = spawnSync(
      'node', [CLI_DIST, ledgerPath, '--dsse', certPath, '--sign-key', deps.keys.privateKeyHex],
      { encoding: 'utf8' },
    );
    expect(sign.status).toBe(0);
    expect(existsSync(certPath)).toBe(true);

    const verify = spawnSync(
      'node', [CLI_DIST, ledgerPath, '--verify-dsse', certPath, '--key', deps.publicKeyHex],
      { encoding: 'utf8' },
    );
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('DSSE valid');

    // ── Step 8: assertions ON DISK, not on any in-memory object ─────────────────────────────
    const cert = JSON.parse(readFileSync(certPath, 'utf8')) as { payload: string };
    const statement = JSON.parse(Buffer.from(cert.payload, 'base64').toString('utf8')) as {
      _type: string;
      predicateType: string;
      subject: [{ digest: { sha256: string } }];
    };
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe('https://github.com/idriszade/warrant/LedgerChain/v1');
    expect(statement.subject[0]!.digest.sha256).toBe(chainHead);
  }, 30_000);
});
