// portfolio/packages/warrant-gatewerk/tests/gatewerk-gate.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { GatewerkGate } from '../src/gatewerk-gate.js';
import type { ReviewDecision } from '../src/types.js';
import create201 from './fixtures/review-create-201.json' with { type: 'json' };
import approved from './fixtures/review-decided-approved.json' with { type: 'json' };
import systemDecided from './fixtures/review-decided-system.json' with { type: 'json' };

const BASE = 'https://gw.example.com';
const KEY = 'test-key';
const CALLBACK = 'https://eve.example.com/warrant/v1/gatewerk/review';
// Deliberately not an email slug. templateSlug is required with no default,
// and a domain-neutral value here is what keeps this suite from re-asserting a domain word the
// package itself must stay blind to.
const SLUG = 'review-template';
const REQ = {
  requestId: 'r1', runId: 'rn1', title: 'T',
  content: { subject: 'S', body: 'B', to: 'a@b.com' },
  metadata: { paramsHash: 'a'.repeat(64), stakesRuleId: 'cold-email' },
};
afterEach(() => vi.restoreAllMocks());

describe('GatewerkGate.submit', () => {
  it('POSTs the exact C6 body shape to {baseUrl}/api/v1/reviews', async () => {
    let captured: { url: string; body: unknown } | undefined;
    const f = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify(create201), { status: 201 });
    });
    await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).submit(REQ);
    expect(captured?.url).toBe(`${BASE}/api/v1/reviews`);
    expect(captured?.body).toEqual({
      template: SLUG,
      payload: REQ.content,
      callback_url: CALLBACK,
      metadata: {
        paramsHash: REQ.metadata.paramsHash,
        stakesRuleId: REQ.metadata.stakesRuleId,
        runId: REQ.runId,
        requestId: REQ.requestId,
      },
      idempotency_key: REQ.requestId,
      oversight: 'blocking',
      priority: 'normal',
    });
    expect((captured?.body as Record<string, unknown>).timeout).toBeUndefined();
  });

  it('the slug is the caller\'s, not the package\'s: a second value produces a second template', async () => {
    let captured: { body: { template?: string } } | undefined;
    const f = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = { body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify(create201), { status: 201 });
    });
    await new GatewerkGate({
      baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: 'custom-template', fetchImpl: f,
    }).submit(REQ);
    expect(captured?.body.template).toBe('custom-template');
  });

  it('201 with the recorded fixture: reviewId is json.id', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(create201), { status: 201 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).submit(REQ);
    expect(r.data?.reviewId).toBe(create201.id);
  });

  it.each([{}, { id: '' }, { id: '   ' }])(
    'response %j with no usable id: err gatewerk_missing_review_id',
    async (body) => {
      const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 201 }));
      const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).submit(REQ);
      expect(r.error?.code).toBe('gatewerk_missing_review_id');
    },
  );

  it('500: err transient gatewerk_api_error', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('err', { status: 500 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).submit(REQ);
    expect(r.error?.code).toBe('gatewerk_api_error');
  });

  it('network throw: err gate_unreachable', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).submit(REQ);
    expect(r.error?.code).toBe('gate_unreachable');
  });

  it("the string literal 'unknown' appears nowhere in gatewerk-gate.ts", async () => {
    const src = await readFile(new URL('../src/gatewerk-gate.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/'unknown'/);
  });
});

describe('GatewerkGate.fetchDecision', () => {
  it('GETs {baseUrl}/api/v1/reviews/{id} and delegates to mapReviewDecision', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(approved), { status: 200 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).fetchDecision(approved.id);
    expect(f.mock.calls[0]?.[0]).toBe(`${BASE}/api/v1/reviews/${approved.id}`);
    expect((r.data as ReviewDecision).decision).toBe('approved');
    expect((r.data as ReviewDecision).decidedBy).toBe(approved.decided_by);
  });

  it('pending status: { pending: true }', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'rv-x', status: 'pending' }), { status: 200 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).fetchDecision('rv-x');
    expect(r.data).toEqual({ pending: true });
  });

  it('404: err gatewerk_api_error', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('nf', { status: 404 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).fetchDecision('x');
    expect(r.error?.code).toBe('gatewerk_api_error');
  });

  it('network throw: err gate_unreachable', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).fetchDecision('x');
    expect(r.error?.code).toBe('gate_unreachable');
  });

  it('system-decided fixture (§2.2 false-attestation hole) never mints: err human_attestation_missing', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(systemDecided), { status: 200 }));
    const r = await new GatewerkGate({ baseUrl: BASE, apiKey: KEY, callbackUrl: CALLBACK, templateSlug: SLUG, fetchImpl: f }).fetchDecision(systemDecided.id);
    expect(r.error?.code).toBe('human_attestation_missing');
  });
});
