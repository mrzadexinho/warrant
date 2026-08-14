// warrant-trigger.ts: the ceremony's ONE channel. Two routes:
//   POST /warrant/v1/run              : starts a governed run
//   POST /warrant/v1/gatewerk/review  : Gatewerk's decision callback
//
// **THEY ARE IN ONE FILE BECAUSE EVE NAMESPACES CONTINUATION TOKENS BY CHANNEL, AND A SESSION CAN
// ONLY BE RESUMED FROM THE CHANNEL THAT STARTED IT.** This is a property of eve, read from eve
// rather than inferred:
//
//   - `createSendFn` (eve 0.25.2, `dist/src/channel/send.js`) computes the runtime token as
//     `` `${channelName}:${rawToken}` `` before calling `runtime.deliver`, and throws
//     *"Cannot deliver inputResponses: the target session was not found via continuation token"*
//     when that lookup misses **and** the payload carries `inputResponses`.
//   - `SendOptions`' own doc comment (`dist/src/channel/routes.d.ts`) states the rule:
//     *"the channel owns its continuation-token format: pass the channel-local raw token (the
//     framework prepends the channel name)"*, the channel name being the file stem under
//     `agent/channels/`. `docs/channels/custom.mdx` §"Continuation tokens" says the same in prose.
//
// If these two routes lived in separate channel files, a token minted as `warrant-trigger:<uuid>`
// would be redeemed as `gatewerk-review:<uuid>`, no session would match, and the parked agent would
// never wake: no outbox row, and `ceremony drain` with nothing to send.
//
// **`RouteHandlerArgs.receive` is NOT the primitive for this.** `CrossChannelReceiveFn`
// (`dist/src/channel/cross-channel-receive.d.ts`) *starts a session on a different channel*; its
// options are `{ message, target, auth }`: no `inputResponses`, no continuation token, so it
// cannot answer a parked input request at all. `getSession(id)` does not help either: the `Session`
// it returns is documented as *"an inert result value"* exposing only `cancel` and
// `getEventStream` (`dist/src/channel/session.d.ts`). Eve offers no cross-channel resume, and
// `session.setContinuationToken` re-keys within the namespace it is already in ("the runtime
// preserves the current channel namespace").
//
// **Do not split these two routes into separate channel files.** Two files would look independent
// while being obliged to share a namespace. Adding a *third* route that neither starts nor resumes
// a session is fine anywhere.
//
// NEVER pass `mode` to send(). Omitting it defaults to 'conversation', which is what
// makes eve's createSendFn derive capabilities:{requestInput:true}; 'task' silently
// disables HITL parking. This is the capabilities.requestInput wiring deliverable itself: a
// default we must not break, not a field we set ourselves. See tests/warrant-trigger.test.ts for
// the regression test that asserts the omission directly.
//
// getDeps() only, never buildDeps(): buildDeps() is the test-only factory. Calling it here
// would give a route its own private ledger/parkStore, invisible to the other route and to
// send_email. One call, one deps object, shared by both routes rather than shared by convention.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { defineChannel, POST } from 'eve/channels';
import { routeAuth } from 'eve/channels/auth';
import type { AuthFn } from 'eve/channels/auth';
import { getDeps } from '../../src/prod-deps.js';
import { consumeParkObserverStream } from '../../src/park-observer.js';
import type { ParkObserverEvent } from '../../src/park-observer.js';
import { handleGatewerkWebhook } from '../../src/webhook-handler.js';

const TRIGGER_SECRET = process.env['WARRANT_TRIGGER_SECRET'] ?? '';
const WEBHOOK_SECRET = process.env['GATEWERK_WEBHOOK_SECRET'] ?? '';

const bearerAuth: AuthFn<Request> = (req) => {
  const header = req.headers.get('authorization') ?? '';
  if (TRIGGER_SECRET === '' || !header.startsWith('Bearer ')) return null;
  const token = Buffer.from(header.slice(7), 'utf8');
  const secret = Buffer.from(TRIGGER_SECRET, 'utf8');
  if (token.length !== secret.length || !timingSafeEqual(token, secret)) return null;
  return {
    attributes: {}, authenticator: 'warrant-trigger-bearer',
    principalId: 'warrant-trigger-caller', principalType: 'service',
  };
};

const deps = getDeps();

export default defineChannel({
  routes: [
    POST('/warrant/v1/run', async (req, { send, waitUntil }) => {
      const authResult = await routeAuth(req, [bearerAuth]);
      if (authResult instanceof Response) return authResult;

      const { message } = await req.json() as { message: string };
      const runId = randomUUID();

      // NEVER pass `mode` here: see the module summary above.
      const session = await send(message, { auth: authResult, continuationToken: runId });

      waitUntil((async () => {
        const stream = await session.getEventStream() as ReadableStream<ParkObserverEvent>;
        await consumeParkObserverStream(stream, {
          ledger: deps.ledger,
          parkStore: deps.parkStore,
          // **`session.id`, NOT the `runId` minted above.** These are two different identifiers,
          // and the observer needs the one the LEDGER is keyed by: `buildApproval` writes every
          // entry with `runId = ctx.session.id`. A run holding no matching `runId` here means the
          // `review.submitted` lookup falls through with no park record ever written, and the park
          // record is what the webhook needs to resume, so the run could reach a real human
          // approval and then have nowhere to land.
          //
          // A batch run IS a Warrant runId; never mint a second. The UUID keeps its one honest job
          // below: it is eve's continuation token, not a run identity.
          runId: session.id,
          continuationToken: runId,
          now: deps.now,
        });
      })());

      return Response.json({ runId, sessionId: session.id }, { status: 202 });
    }),

    // Thin wiring only: all real logic (signature check, doorbell extraction, resumeByPoll) lives
    // in ../../src/webhook-handler.ts, which is eve-free and unit-tested directly. This route only
    // turns a resumed outcome into eve's resume call, and it must be THIS channel's `send`, per
    // the module summary above.
    //
    // `optionId` is the runtime's hardcoded approval enum:
    // 'approve' or 'deny', never a custom id. `deliver` below maps the webhook-handler's
    // 'approved'/'denied' outcome onto exactly that pair.
    POST('/warrant/v1/gatewerk/review', async (req, { send }) => {
      // Raw bytes BEFORE any JSON parsing: the signature covers the raw body.
      const rawBody = await req.text();

      const outcome = await handleGatewerkWebhook(deps, {
        rawBody, headers: req.headers, secret: WEBHOOK_SECRET,
        deliver: async (rec, decision) => {
          // auth: null: this route's trust boundary is the signature check inside
          // handleGatewerkWebhook (defense in depth), not eve's
          // routeAuth. ParkRecord carries no auth object to hand back here.
          //
          // `rec.continuationToken` is the channel-local raw token written by the park observer
          // above: eve prepends `warrant-trigger:` on both the mint and this redemption, which is
          // the whole point of the two routes sharing a file.
          await send(
            {
              inputResponses: [
                { requestId: rec.eveRequestId, optionId: decision === 'approved' ? 'approve' : 'deny' },
              ],
            },
            { auth: null, continuationToken: rec.continuationToken },
          );
        },
      });

      return Response.json(outcome.body, { status: outcome.status });
    }),
  ],
});
