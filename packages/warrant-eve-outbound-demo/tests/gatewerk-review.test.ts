// Tests for the `POST /warrant/v1/gatewerk/review` route. **It lives in
// agent/channels/warrant-trigger.ts, not in a channel of its own**: eve namespaces
// continuation tokens by channel name, so only the channel that parked a session can resume it.
// This file keeps its own name because it tests that route; the co-location invariant itself is
// pinned in warrant-trigger.test.ts, where the trigger route is.
//
// eve/channels is a devDependency and a building/typing surface only here: no eve runtime or HTTP
// server is started. The route handler is invoked directly with a spy `send`, matching the pattern
// in warrant-trigger.test.ts.
//
// All resumeByPoll/policy logic is exercised directly in webhook-handler.test.ts; this file
// only proves the route's own wiring: that the RESOLVED outcome from handleGatewerkWebhook
// (mocked here) turns into the correct call to `send`, with the runtime's fixed 'approve'/
// 'deny' optionId enum (never a custom id) and the park record's continuationToken/
// eveRequestId (never anything sourced from the webhook body).
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RouteHandlerArgs, Session } from 'eve/channels';
import type { WebhookOutcome, WebhookHandlerOpts } from '../src/webhook-handler.js';
import { routeByPath } from './helpers/route-by-path.js';

const ROUTE = '/warrant/v1/gatewerk/review';

const { handleGatewerkWebhookMock } = vi.hoisted(() => ({ handleGatewerkWebhookMock: vi.fn() }));
vi.mock('../src/webhook-handler.js', () => ({
  handleGatewerkWebhook: handleGatewerkWebhookMock,
}));

async function loadRoute() {
  vi.resetModules();
  const mod = await import('../agent/channels/warrant-trigger.js');
  return routeByPath(mod.default, ROUTE);
}

function stubArgs(overrides: Partial<RouteHandlerArgs<undefined>>): RouteHandlerArgs<undefined> {
  return {
    send: vi.fn(),
    waitUntil: () => {},
    cancel: async () => { throw new Error('n/a'); },
    getSession: () => { throw new Error('n/a'); },
    receive: async () => { throw new Error('n/a'); },
    params: {},
    requestIp: null,
    ...overrides,
  } as unknown as RouteHandlerArgs<undefined>;
}

const PARK_RECORD = {
  reviewId: 'review-1', runId: 'run-1', callId: 'call-1',
  eveRequestId: 'eve-req-1', continuationToken: 'tok-1', parkedAt: '2026-07-26T12:00:00.000Z',
};

describe('warrant-trigger channel: POST /warrant/v1/gatewerk/review', () => {
  afterEach(() => {
    // handleGatewerkWebhookMock is a module-level mock shared across every test in this
    // file (vi.mock is hoisted once): a "Once" queued behavior that a test never consumes
    // (e.g. because it never calls route.handler) would otherwise leak into the next
    // test's call and shift every following assertion by one.
    handleGatewerkWebhookMock.mockReset();
  });

  it('registers the exact route path and method', async () => {
    const route = await loadRoute();
    expect(route.method).toBe('POST');
    expect(route.path).toBe('/warrant/v1/gatewerk/review');
  });

  it("deliver('approved') resumes the parked session with optionId 'approve'", async () => {
    handleGatewerkWebhookMock.mockImplementationOnce(async (_deps: unknown, opts: WebhookHandlerOpts) => {
      await opts.deliver(PARK_RECORD, 'approved');
      return { status: 200, body: { ok: true, outcome: 'issued' } } as WebhookOutcome;
    });

    const route = await loadRoute();
    const sendSpy = vi.fn(async () => ({ id: 'session-1' }) as unknown as Session);
    const req = new Request('http://localhost/warrant/v1/gatewerk/review', {
      method: 'POST',
      body: JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'approved' }),
    });

    const response = await route.handler(req, stubArgs({ send: sendSpy }));

    expect(sendSpy).toHaveBeenCalledWith(
      { inputResponses: [{ requestId: 'eve-req-1', optionId: 'approve' }] },
      { auth: null, continuationToken: 'tok-1' },
    );
    expect(response.status).toBe(200);
  });

  it("deliver('denied') resumes the parked session with optionId 'deny'", async () => {
    handleGatewerkWebhookMock.mockImplementationOnce(async (_deps: unknown, opts: WebhookHandlerOpts) => {
      await opts.deliver(PARK_RECORD, 'denied');
      return { status: 200, body: { ok: true, outcome: 'denied' } } as WebhookOutcome;
    });

    const route = await loadRoute();
    const sendSpy = vi.fn(async () => ({ id: 'session-1' }) as unknown as Session);
    // The webhook body's own `decision` field says 'approved': irrelevant. The channel only
    // ever reacts to the outcome the (mocked) handler's deliver callback is invoked with.
    const req = new Request('http://localhost/warrant/v1/gatewerk/review', {
      method: 'POST',
      body: JSON.stringify({ type: 'review.decided', review_id: 'review-1', decision: 'approved' }),
    });

    const response = await route.handler(req, stubArgs({ send: sendSpy }));

    expect(sendSpy).toHaveBeenCalledWith(
      { inputResponses: [{ requestId: 'eve-req-1', optionId: 'deny' }] },
      { auth: null, continuationToken: 'tok-1' },
    );
    expect(response.status).toBe(200);
  });

  it('propagates the handler status/body verbatim (e.g. 503 pending) without calling send', async () => {
    handleGatewerkWebhookMock.mockResolvedValueOnce({ status: 503, body: { error: 'pending' } } as WebhookOutcome);
    const route = await loadRoute();
    const sendSpy = vi.fn();
    const req = new Request('http://localhost/warrant/v1/gatewerk/review', {
      method: 'POST', body: JSON.stringify({ type: 'review.decided', review_id: 'review-1' }),
    });

    const response = await route.handler(req, stubArgs({ send: sendSpy }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'pending' });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
