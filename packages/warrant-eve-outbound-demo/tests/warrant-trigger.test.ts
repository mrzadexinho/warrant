// Tests for agent/channels/warrant-trigger.ts. eve/channels is a devDependency and a
// building/typing surface only here: no eve runtime or HTTP server is started. The route
// handler is invoked directly with a spy `send` and `waitUntil`.
//
// This test exists specifically because an adversarial review flagged that nothing
// asserted the `mode` omission on send(): a comment alone is not a guard.
//
// Routes are selected BY PATH, never by index. `routes[0]` is a hand-maintained
// assumption nothing else checks, and this channel carries two routes. `routeByPath` fails
// loudly instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RouteHandlerArgs, Session } from 'eve/channels';
import { routeByPath } from './helpers/route-by-path.js';

const ORIGINAL_SECRET = process.env['WARRANT_TRIGGER_SECRET'];
const SECRET = 'test-trigger-secret';

async function loadChannel() {
  process.env['WARRANT_TRIGGER_SECRET'] = SECRET;
  vi.resetModules();
  const mod = await import('../agent/channels/warrant-trigger.js');
  return mod.default;
}

function emptyStream(): ReadableStream<unknown> {
  return new ReadableStream({ start(controller) { controller.close(); } });
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

describe('warrant-trigger channel: POST /warrant/v1/run', () => {
  afterEach(() => {
    process.env['WARRANT_TRIGGER_SECRET'] = ORIGINAL_SECRET;
  });

  // Eve namespaces continuation tokens as `${channelName}:${rawToken}`, the channel name being
  // the file stem under `agent/channels/`, so a session parked by one channel can only ever be
  // resumed by that same channel. If the Gatewerk callback lived in its own `gatewerk-review.ts`,
  // `send({inputResponses})` would look up `gatewerk-review:<uuid>` for a session parked under
  // `warrant-trigger:<uuid>`, throw "the target session was not found via continuation token", and
  // the parked agent would never wake: empty outbox, and `ceremony drain` with nothing to send.
  //
  // This asserts the property directly rather than the file layout: both routes are served by ONE
  // channel module, therefore by one namespace. Move either back into its own channel file and
  // this fails.
  it('serves the trigger AND the resume route from one channel, so both share a token namespace', async () => {
    const channel = await loadChannel();
    expect(channel.routes).toHaveLength(2);
    expect(routeByPath(channel, '/warrant/v1/run').method).toBe('POST');
    expect(routeByPath(channel, '/warrant/v1/gatewerk/review').method).toBe('POST');
  });

  it('never passes `mode` to send(), which is what keeps HITL parking enabled', async () => {
    const channel = await loadChannel();
    const route = routeByPath(channel, '/warrant/v1/run');
    expect(route.method).toBe('POST');

    const session = { id: 'session-1', getEventStream: async () => emptyStream() } as unknown as Session;
    // Typed with its real arity on purpose. `vi.fn(async () => session)` infers a
    // zero-argument signature, so `mock.calls[0]` is an empty tuple and `call[1]`
    // does not typecheck even though it exists at runtime. That matters here more
    // than usual: `call[1]` is the options object this test inspects to prove no
    // `mode` key is passed, and a type error on the load-bearing assertion invites
    // someone to weaken the assertion rather than fix the spy.
    const sendSpy = vi.fn(async (_input: unknown, _options: Record<string, unknown>) => session);
    const waitUntilCalls: Promise<unknown>[] = [];

    const req = new Request('http://localhost/warrant/v1/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'send the outbound email' }),
    });

    const response = await route.handler(req, stubArgs({
      send: sendSpy,
      waitUntil: (p: Promise<unknown>) => { waitUntilCalls.push(p); },
    }));
    expect(response.status).toBe(202);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0]!;
    const options = call[1] as Record<string, unknown>;
    // The exact assertion the adversarial review found missing: no `mode` key present.
    expect('mode' in options).toBe(false);
    expect(options['continuationToken']).toBeTruthy();
    expect(options['auth']).toBeDefined();

    // The background park-observer drain must not throw or reject.
    await Promise.all(waitUntilCalls);
  });

  it('rejects an unauthenticated request and never calls send()', async () => {
    const channel = await loadChannel();
    const route = routeByPath(channel, '/warrant/v1/run');
    const sendSpy = vi.fn();
    const req = new Request('http://localhost/warrant/v1/run', {
      method: 'POST', body: JSON.stringify({ message: 'hi' }),
    });

    const response = await route.handler(req, stubArgs({ send: sendSpy }));
    expect(response.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
