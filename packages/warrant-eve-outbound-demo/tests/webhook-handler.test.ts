// Tests for src/webhook-handler.ts (master Task 10, C10/C11). eve is a types-only
// dependency here: no eve runtime is started.
//
// THE DOORBELL PROPERTY is the single most important thing this file proves: the webhook
// body's `decision` field must never influence the outcome. Both DOORBELL tests below stub
// the Gate to disagree with the body on purpose. If the gate's decision always wins, the
// property holds; if either test fails, a forged webhook body could change what gets minted.
//
// The RAW-BYTES test proves signature verification runs on the bytes as delivered, not on a
// parsed-then-reserialized document: it hand-builds a body whose whitespace and key order
// differ from what `JSON.stringify` would produce, signs exactly that string, and asserts it
// still verifies.
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { MemoryParkStore } from '@idriszade/warrant-eve';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Gate, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { generateKeyPair } from '@idriszade/warrant-core';
import { loadPolicy } from '@idriszade/warrant-policy';
import { ok } from '@idriszade/core';
import { handleGatewerkWebhook } from '../src/webhook-handler.js';
import type { WarrantEveDeps } from '@idriszade/warrant-eve';

const SECRET = 'whsec-test';
const NOW = () => new Date('2026-07-26T12:00:00.000Z');

function sign(rawBody: string): Headers {
  const id = 'msg-1';
  const ts = Math.floor(NOW().getTime() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${id}\n${ts}\n${rawBody}`, 'utf8').digest('base64');
  return new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` });
}

class StubGate implements Gate {
  constructor(private readonly decision: ReviewDecision | { pending: true }) {}
  async submit() { return ok({ reviewId: 'unused' }); }
  async fetchDecision() { return ok(this.decision); }
}

const POLICY = loadPolicy(`
version: "1.0.0"
defaults: { path: deny }
stakes:
  - id: send_email_human
    match: { actionKind: send_email }
    path: human
protectedAudiences: []
caps: { perPrincipalDaily: {} }
`.trim()).data!;

function makeDeps(gate: Gate) {
  const ledger = new MemoryLedger();
  const parkStore = new MemoryParkStore();
  const keys = generateKeyPair('33'.repeat(32));
  const deps: WarrantEveDeps = {
    policy: POLICY, keys, publicKeyHex: keys.publicKeyHex, ledger, gate, now: NOW,
    newId: (() => { let t = 0; return () => `id-${++t}`; })(),
    autoTtlMs: 60_000, humanTtlMs: 3_600_000, reviewTimeoutMs: 3_600_000, parkStore,
  };
  return { deps, ledger, parkStore };
}

async function seedParkedReview(
  ledger: MemoryLedger, parkStore: MemoryParkStore,
  opts: { requestId: string; reviewId: string; runId: string },
): Promise<void> {
  const principal = { kind: 'agent' as const, id: 'agent-1' };
  const content = { to: 'x@corp.com', subject: 'S', body: 'B' };
  await ledger.append({
    runId: opts.runId, at: NOW().toISOString(), event: 'warrant.requested',
    principal, payload: { requestId: opts.requestId, actionKind: 'send_email', target: content.to, context: {} },
  });
  await ledger.append({
    runId: opts.runId, at: NOW().toISOString(), event: 'policy.evaluated',
    principal, payload: { requestId: opts.requestId, ruleId: 'send_email_human', path: 'human' },
  });
  await ledger.append({
    runId: opts.runId, at: NOW().toISOString(), event: 'review.submitted',
    principal, payload: { requestId: opts.requestId, reviewId: opts.reviewId, content },
  });
  await parkStore.put({
    reviewId: opts.reviewId, runId: opts.runId, callId: opts.requestId,
    eveRequestId: 'eve-req-1', continuationToken: 'tok-1', parkedAt: NOW().toISOString(),
  });
}

async function hasEvent(ledger: MemoryLedger, runId: string, event: string): Promise<boolean> {
  const entries = (await ledger.readRun(runId)).data!;
  return entries.some((e) => e.event === event);
}

describe('handleGatewerkWebhook', () => {
  it('invalid signature -> 401, resumeByPoll never called', async () => {
    const { deps } = makeDeps(new StubGate({ pending: true }));
    const resumeSpy = vi.fn();
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1' });
    const out = await handleGatewerkWebhook(deps, {
      rawBody: body,
      headers: new Headers({ 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,bad' }),
      secret: SECRET, deliver: vi.fn(), resume: resumeSpy,
    });
    expect(out.status).toBe(401);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('unknown reviewId -> 404, resumeByPoll never called, no mint', async () => {
    const { deps, ledger } = makeDeps(new StubGate({ pending: true }));
    const resumeSpy = vi.fn();
    const body = JSON.stringify({ type: 'review.decided', review_id: 'never-parked' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: vi.fn(), resume: resumeSpy });
    expect(out.status).toBe(404);
    expect(out.body['error']).toBe('park_not_found');
    expect(resumeSpy).not.toHaveBeenCalled();
    expect((await ledger.readAll()).data).toHaveLength(0);
  });

  it('DOORBELL: body says approved, gate says rejected -> rejected wins, no mint of warrant.issued', async () => {
    const gate = new StubGate({ reviewId: 'review-1', decision: 'rejected', decidedBy: 'human:reviewer-1' });
    const { deps, ledger, parkStore } = makeDeps(gate);
    await seedParkedReview(ledger, parkStore, { requestId: 'call-1', reviewId: 'review-1', runId: 'run-1' });
    const deliverSpy = vi.fn(async () => {});
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'approved' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: deliverSpy });
    expect(out.status).toBe(200);
    expect(out.body['outcome']).toBe('denied');
    expect(deliverSpy).toHaveBeenCalledWith(expect.anything(), 'denied');
    expect(await hasEvent(ledger, 'run-1', 'warrant.issued')).toBe(false);
    expect(await hasEvent(ledger, 'run-1', 'warrant.denied')).toBe(true);
  });

  it('DOORBELL (inverse): body says rejected, gate says approved -> approved wins, warrant.issued exists', async () => {
    const gate = new StubGate({ reviewId: 'review-1', decision: 'approved', decidedBy: 'human:reviewer-1' });
    const { deps, ledger, parkStore } = makeDeps(gate);
    await seedParkedReview(ledger, parkStore, { requestId: 'call-1', reviewId: 'review-1', runId: 'run-1' });
    const deliverSpy = vi.fn(async () => {});
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'rejected' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: deliverSpy });
    expect(out.status).toBe(200);
    expect(out.body['outcome']).toBe('issued');
    expect(deliverSpy).toHaveBeenCalledWith(expect.anything(), 'approved');
    expect(await hasEvent(ledger, 'run-1', 'warrant.issued')).toBe(true);
    expect(await hasEvent(ledger, 'run-1', 'warrant.denied')).toBe(false);
  });

  it('gate reports pending -> 503, no claim written', async () => {
    const { deps, ledger, parkStore } = makeDeps(new StubGate({ pending: true }));
    await seedParkedReview(ledger, parkStore, { requestId: 'call-1', reviewId: 'review-1', runId: 'run-1' });
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: vi.fn() });
    expect(out.status).toBe(503);
    expect(await hasEvent(ledger, 'run-1', 'review.decided')).toBe(false);
  });

  it('happy path approved -> 200, warrant.issued exists, deliver called with approved', async () => {
    const gate = new StubGate({ reviewId: 'review-1', decision: 'approved', decidedBy: 'human:reviewer-1' });
    const { deps, ledger, parkStore } = makeDeps(gate);
    await seedParkedReview(ledger, parkStore, { requestId: 'call-1', reviewId: 'review-1', runId: 'run-1' });
    const deliverSpy = vi.fn(async () => {});
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'approved' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: deliverSpy });
    expect(out.status).toBe(200);
    expect(out.body['outcome']).toBe('issued');
    expect(deliverSpy).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review-1' }), 'approved');
    expect(await hasEvent(ledger, 'run-1', 'warrant.issued')).toBe(true);
  });

  it('happy path rejected -> 200, warrant.denied exists, deliver called with denied', async () => {
    const gate = new StubGate({ reviewId: 'review-1', decision: 'rejected', decidedBy: 'human:reviewer-1' });
    const { deps, ledger, parkStore } = makeDeps(gate);
    await seedParkedReview(ledger, parkStore, { requestId: 'call-1', reviewId: 'review-1', runId: 'run-1' });
    const deliverSpy = vi.fn(async () => {});
    const body = JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'rejected' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: deliverSpy });
    expect(out.status).toBe(200);
    expect(out.body['outcome']).toBe('denied');
    expect(deliverSpy).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review-1' }), 'denied');
    expect(await hasEvent(ledger, 'run-1', 'warrant.denied')).toBe(true);
  });

  it('body is not JSON -> rejected without calling resumeByPoll', async () => {
    const { deps } = makeDeps(new StubGate({ pending: true }));
    const resumeSpy = vi.fn();
    const body = 'not-json-at-all';
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: vi.fn(), resume: resumeSpy });
    expect(out.status).toBe(400);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('body missing `type` -> rejected without calling resumeByPoll', async () => {
    const { deps } = makeDeps(new StubGate({ pending: true }));
    const resumeSpy = vi.fn();
    const body = JSON.stringify({ review_id: 'review-1' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: vi.fn(), resume: resumeSpy });
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('body `type` set to something else -> rejected without calling resumeByPoll', async () => {
    const { deps } = makeDeps(new StubGate({ pending: true }));
    const resumeSpy = vi.fn();
    const body = JSON.stringify({ type: 'review.created', review_id: 'review-1' });
    const out = await handleGatewerkWebhook(deps,
      { rawBody: body, headers: sign(body), secret: SECRET, deliver: vi.fn(), resume: resumeSpy });
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(out.status).not.toBe(401);
  });

  it('signature verifies over the RAW bytes: a parse-then-reserialize implementation would reject this', async () => {
    // Deliberately NOT what JSON.stringify would produce: review_id before type, pretty
    // whitespace. A handler that verified JSON.stringify(JSON.parse(rawBody)) instead of
    // rawBody itself would compute the HMAC over different bytes and reject a valid delivery.
    const reviewId = 'review-raw-bytes';
    const rawBody = `{\n  "review_id": "${reviewId}",\n  "type": "review.decided"\n}`;
    expect(rawBody).not.toBe(JSON.stringify(JSON.parse(rawBody)));
    const { deps } = makeDeps(new StubGate({ pending: true }));
    const out = await handleGatewerkWebhook(deps,
      { rawBody, headers: sign(rawBody), secret: SECRET, deliver: vi.fn() });
    // Not parked, so 404: the point is that verification did not fail with 401 first.
    expect(out.status).toBe(404);
  });
});
