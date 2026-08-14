/**
 * live-e2e-smoke.test.ts: Task 12 OPT-IN real-runtime smoke (design spec section 12.3 "the live
 * run is the final test", local half). Builds and boots the actual eve server (`eve build` then
 * `eve start`), drives a real model call through the trigger route (00-master.md C10:
 * POST /warrant/v1/run), and resumes it through the real webhook route
 * (POST /warrant/v1/gatewerk/review). Gated exactly like warrant-ledger/tests/postgres-smoke:
 * skips cleanly when the credential is absent, no failure, no hang.
 *
 * Credential: `agent/agent.ts` declares `model: 'anthropic/claude-sonnet-5'`. eve resolves a
 * model's provider slug to an env var by convention (verified directly in
 * node_modules/eve/dist/src/setup/scaffold/create/project.d.ts: "model's provider slug (e.g.
 * `anthropic/...` -> `ANTHROPIC_API_KEY`)"), so ANTHROPIC_API_KEY is the credential this demo
 * agent actually needs, not an assumption carried over from the stale plan draft.
 *
 * FLAGGED ASSUMPTION (unchanged from the plan, independently confirmed against source): local-
 * dev channel wiring (agent/tools/send_email.ts -> src/prod-deps.ts -> src/build.ts) still uses
 * `SimGate([])` as the default gate, matching design spec section 9's "Milestone A (demo)" gate
 * row. A live GatewerkGate needs secrets that section 10 deployment (Pass 2) deliberately does
 * not provision yet. SimGate assigns reviewIds sequentially from a fresh in-process counter, and
 * an empty script defaults every verdict to 'approve' (sim-gate.ts: `this.#script[idx] ??
 * 'approve'`), so the first review submitted by a freshly-started `eve start` process is
 * deterministically `sim-0`, approved. If a future task wires a different local-dev default
 * gate, only the REVIEW_ID constant below needs updating.
 *
 * See this file's companions: live-e2e.test.ts (always-run, fully-local proof through the real
 * GatewerkGate) and live-e2e-edits.test.ts (approve-with-edits). This file only adds confidence
 * that the two channels are actually wired into a real `eve build` output end to end.
 *
 * TRIGGER AUTH: agent/channels/warrant-trigger.ts's bearerAuth fails closed when
 * WARRANT_TRIGGER_SECRET is unset (`TRIGGER_SECRET === '' -> return null`) and routeAuth() 401s
 * when every AuthFn returns null (eve/channels/auth: routeAuth's final fallback is a 401 with a
 * Bearer challenge). So this test sets WARRANT_TRIGGER_SECRET on the spawned server and sends
 * the matching bearer token on the trigger request; omitting either would make the whole smoke
 * fail on a 401 before ever reaching the governed run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_KEY = process.env['ANTHROPIC_API_KEY'];
const DEMO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = process.env['GATEWERK_WEBHOOK_SECRET'] ?? 'smoke-webhook-secret';
const TRIGGER_SECRET = process.env['WARRANT_TRIGGER_SECRET'] ?? 'smoke-trigger-secret';
// ASSUMPTION (see module header): local dev wiring uses SimGate([]), whose first reviewId in a
// freshly-started process is deterministically 'sim-0'.
const REVIEW_ID = 'sim-0';

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/eve/v1/health`);
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('eve start did not become healthy in time');
}

async function waitForParked(sessionId: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const res = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream?startIndex=0`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes('"type":"session.waiting"')) { await reader.cancel().catch(() => {}); return true; }
  }
  await reader.cancel().catch(() => {});
  return false;
}

describe.skipIf(!MODEL_KEY)('real eve runtime: park + resume (Task 12 opt-in smoke)', () => {
  let server: ChildProcess;

  beforeAll(async () => {
    const build = spawnSync('npx', ['eve', 'build'], { cwd: DEMO_ROOT, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`eve build failed: ${build.stderr}`);
    server = spawn('npx', ['eve', 'start', '--port', String(PORT)], {
      cwd: DEMO_ROOT,
      env: {
        ...process.env, PORT: String(PORT),
        GATEWERK_WEBHOOK_SECRET: WEBHOOK_SECRET, WARRANT_TRIGGER_SECRET: TRIGGER_SECRET,
      },
    });
    await waitForHealth();
  }, 60_000);

  afterAll(() => { server?.kill(); });

  it('trigger parks a cold-audience send_email call; webhook resumes it', async () => {
    const triggerRes = await fetch(`${BASE}/warrant/v1/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TRIGGER_SECRET}` },
      body: JSON.stringify({ message: 'Send an outbound email to prospect@corp.com (audience: cold) introducing our product.' }),
    });
    expect(triggerRes.status).toBe(202);
    const { sessionId } = (await triggerRes.json()) as { runId: string; sessionId: string };
    expect(sessionId).toBeTruthy();

    expect(await waitForParked(sessionId)).toBe(true);

    const rawBody = JSON.stringify({ type: 'review.decided', review_id: REVIEW_ID });
    const webhookId = 'smoke-msg-1';
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${webhookId}\n${ts}\n${rawBody}`).digest('base64');

    const webhookRes = await fetch(`${BASE}/warrant/v1/gatewerk/review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}`,
      },
      body: rawBody,
    });
    expect(webhookRes.status).toBe(200);
  }, 45_000);
});
