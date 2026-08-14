// webhook-handler.ts: all real logic behind the `POST /warrant/v1/gatewerk/review` route.
// eve-free and unit-testable: no import from `eve` anywhere in this module.
//
// That route is mounted in `agent/channels/warrant-trigger.ts` and NOT in a channel of its own:
// eve namespaces continuation tokens by channel, so only the channel that parked a session
// can resume it. Nothing in this file depends on that, which is the point: the constraint is
// eve's and stays at the eve boundary.
//
// THE DOORBELL PROPERTY (load-bearing). The webhook body carries `decision`,
// `edited_payload`, `was_edited`, `feedback`. None of that is read below. Only `type` and
// `review_id` are extracted from the parsed body, and `resumeByPoll` re-fetches the decision
// from Gatewerk, the sole authority. A forged or stale body can only ever buy an attacker one
// extra poll of an API that tells the truth: signature verification below is defense in
// depth, not the security boundary.
//
// The signature covers the RAW request bytes. Verification happens on `rawBody`
// BEFORE any `JSON.parse` call: parsing and re-serializing to verify would check a document
// that is not necessarily byte-identical to what was signed (key order, whitespace), which is
// a defect this ordering avoids.
//
// `pending` maps to 503, not 200 (resumeByPoll step 5, master C11): `pending` means Gatewerk
// told us a review was decided and then told us it was not, a read-after-write race against
// its own database. A 200 would acknowledge a decision this process never applied and strand
// the parked run forever. 503 returns the delivery to Gatewerk's retry backoff, and
// resumeByPoll is idempotent, so redelivery is safe.
import { verifyGatewerkWebhook } from '@idriszade/warrant-gatewerk';
import { resumeByPoll } from '@idriszade/warrant-eve';
import type { WarrantEveDeps, ParkRecord } from '@idriszade/warrant-eve';

export interface WebhookOutcome {
  status: 200 | 400 | 401 | 404 | 500 | 503;
  body: Record<string, unknown>;
}

export interface WebhookHandlerOpts {
  rawBody: string;
  headers: Headers;
  secret: string;
  deliver: (rec: ParkRecord, outcome: 'approved' | 'denied') => Promise<void>;
  // Injectable for tests; defaults to the real resumeByPoll. No production caller overrides it.
  resume?: typeof resumeByPoll;
}

export async function handleGatewerkWebhook(
  deps: WarrantEveDeps,
  opts: WebhookHandlerOpts,
): Promise<WebhookOutcome> {
  const resume = opts.resume ?? resumeByPoll;

  // Verify over the raw bytes as delivered, before any parsing.
  const verified = verifyGatewerkWebhook({
    rawBody: opts.rawBody, headers: opts.headers, secret: opts.secret, now: deps.now,
  });
  if (!verified) return { status: 401, body: { error: 'invalid_signature' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed_webhook_body' } };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { error: 'malformed_webhook_body' } };
  }
  const body = parsed as Record<string, unknown>;

  // Doorbell: only `type` and `review_id` are read from here down. Nothing else in `body`
  // (decision, edited_payload, was_edited, feedback) may influence the outcome; resume()
  // re-fetches the decision from Gatewerk below.
  if (body['type'] !== 'review.decided') {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  const reviewId = body['review_id'];
  if (typeof reviewId !== 'string' || reviewId === '') {
    return { status: 400, body: { error: 'malformed_webhook_body' } };
  }

  const parkResult = await deps.parkStore.get(reviewId);
  if (parkResult.error) return { status: 500, body: { error: parkResult.error.code } };
  const rec = parkResult.data;
  if (!rec) return { status: 404, body: { error: 'park_not_found' } };

  const resumeResult = await resume(deps, {
    reviewId,
    runId: rec.runId,
    deliver: (outcome) => opts.deliver(rec, outcome),
  });
  if (resumeResult.error) return { status: 500, body: { error: resumeResult.error.code } };
  if (resumeResult.data === 'pending') return { status: 503, body: { error: 'pending' } };
  return { status: 200, body: { ok: true, outcome: resumeResult.data } };
}
