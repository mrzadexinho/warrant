// portfolio/packages/warrant-gatewerk/src/webhook.ts
//
// Verifies Gatewerk webhook deliveries across three signature schemes (C8):
// standard (Standard Webhooks spec, https://www.standardwebhooks.com), v2
// (Stripe-style replay-safe envelope), and v1 (legacy, no replay protection).
// Preference order tries standard first, then v2, then v1: v1 carries no
// timestamp, so it offers no replay protection and is kept last.
//
// Signed-message construction verified directly against Gatewerk's own
// signing code, not against the plan text alone:
//   apps/api/src/services/webhooks/standard-webhooks.ts (standard scheme)
//   apps/api/src/services/webhooks.ts, WebhookService#sign (v1, v2)
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookScheme = 'standard' | 'v2' | 'v1';

const DEFAULT_TOLERANCE_MS = 300_000;
const DEFAULT_SCHEMES: readonly WebhookScheme[] = ['standard', 'v2', 'v1'];

function hmacHex(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function hmacBase64(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('base64');
}

// Buffer.from(str, 'base64'|'hex') never throws on malformed input: invalid
// characters are silently dropped (hex) or ignored (base64), which can produce
// a buffer of unexpected length. That is exactly what the length guard below
// is for, so decoding itself is safe to call unconditionally.
function decode(value: string, encoding: 'base64' | 'hex'): Buffer {
  return Buffer.from(value, encoding);
}

// timingSafeEqual throws on unequal-length buffers: guard explicitly so a
// truncated, garbage, or wrong-encoding signature returns false instead of
// throwing.
function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Math.abs is load-bearing here: a future-dated timestamp beyond tolerance
// must be rejected exactly like a stale one, not just a past-only check. A
// one-directional (stale-only) comparison would pass every valid-signature
// test while still accepting a forged future timestamp.
function withinTolerance(now: () => Date, tsSeconds: number, toleranceMs: number): boolean {
  if (!Number.isFinite(tsSeconds)) return false;
  return Math.abs(now().getTime() - tsSeconds * 1000) <= toleranceMs;
}

function verifyStandard(
  rawBody: string,
  headers: Headers,
  secret: string,
  now: () => Date,
  toleranceMs: number,
): boolean {
  const id = headers.get('webhook-id');
  const tsHeader = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !tsHeader || !sigHeader) return false;
  const ts = Number(tsHeader);
  if (!Number.isInteger(ts) || !withinTolerance(now, ts, toleranceMs)) return false;
  const expected = decode(hmacBase64(`${id}\n${tsHeader}\n${rawBody}`, secret), 'base64');
  // webhook-signature is a space-separated list of `v1,<sig>` entries for key
  // rotation: accept the delivery if ANY entry matches.
  const entries = sigHeader
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  return entries.some((entry) => safeEqual(decode(entry, 'base64'), expected));
}

function verifyV2(rawBody: string, headers: Headers, secret: string, now: () => Date, toleranceMs: number): boolean {
  const header = headers.get('x-webhook-signature-v2');
  if (!header) return false;
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;
  const [, tsStr, hex] = match;
  if (tsStr === undefined || hex === undefined) return false;
  if (!withinTolerance(now, Number(tsStr), toleranceMs)) return false;
  const expected = decode(hmacHex(`${tsStr}.${rawBody}`, secret), 'hex');
  return safeEqual(decode(hex, 'hex'), expected);
}

function verifyV1(rawBody: string, headers: Headers, secret: string): boolean {
  const header = headers.get('x-webhook-signature');
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = decode(hmacHex(rawBody, secret), 'hex');
  return safeEqual(decode(header.slice(7), 'hex'), expected);
}

export function verifyGatewerkWebhook(opts: {
  rawBody: string;
  headers: Headers;
  secret: string;
  now: () => Date;
  toleranceMs?: number;
  accept?: readonly WebhookScheme[];
}): boolean {
  try {
    const toleranceMs = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    const accept = opts.accept ?? DEFAULT_SCHEMES;
    for (const scheme of accept) {
      if (scheme === 'standard' && verifyStandard(opts.rawBody, opts.headers, opts.secret, opts.now, toleranceMs)) {
        return true;
      }
      if (scheme === 'v2' && verifyV2(opts.rawBody, opts.headers, opts.secret, opts.now, toleranceMs)) return true;
      if (scheme === 'v1' && verifyV1(opts.rawBody, opts.headers, opts.secret)) return true;
    }
    return false;
  } catch {
    // Never throws: any malformed input (bad headers, unexpected shapes) must
    // fail closed, not propagate to the caller.
    return false;
  }
}

/**
 * Deprecated: thin wrapper over the legacy v1 comparison, preserved so
 * existing callers and tests/webhook.test.ts keep passing unchanged. Unlike
 * the v1 scheme inside verifyGatewerkWebhook, this compares a bare hex digest
 * with no "sha256=" prefix: that is this function's historical contract.
 * @deprecated use verifyGatewerkWebhook with accept: ['v1'] for new code.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  const a = Buffer.from(hmacHex(rawBody, secret), 'utf8');
  const b = Buffer.from(signatureHeader.toLowerCase(), 'utf8');
  // Length guard: timingSafeEqual requires equal-length buffers; bail early without revealing info.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
