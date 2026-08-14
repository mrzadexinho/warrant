// portfolio/packages/warrant-gatewerk/tests/webhook-verify.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGatewerkWebhook } from '../src/webhook.js';

const SECRET = 'wh-secret';
const BODY = JSON.stringify({ type: 'review.decided', review_id: 'rv-1' });
const NOW_MS = new Date('2026-07-26T12:00:00.000Z').getTime();
const NOW = () => new Date(NOW_MS);
const NOW_S = Math.floor(NOW_MS / 1000);

function standardSignature(id: string, ts: number, body: string, secret = SECRET): string {
  return `v1,${createHmac('sha256', secret).update(`${id}\n${ts}\n${body}`).digest('base64')}`;
}

function standardHeaders(body: string, ts = NOW_S, secrets = [SECRET]) {
  const sigs = secrets.map((s) => standardSignature('wh-1', ts, body, s)).join(' ');
  return new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(ts), 'webhook-signature': sigs });
}

function v2Headers(body: string, ts = NOW_S, secret = SECRET) {
  return new Headers({
    'x-webhook-signature-v2': `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`,
  });
}

function v1Headers(body: string, secret = SECRET) {
  return new Headers({ 'x-webhook-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` });
}

describe('verifyGatewerkWebhook: standard scheme', () => {
  it('valid signature verifies', () => {
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers: standardHeaders(BODY), secret: SECRET, now: NOW })).toBe(true);
  });
  it('tampered body fails', () => {
    const headers = standardHeaders(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY + 'x', headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('rotation: verifies when only the second entry matches', () => {
    const headers = standardHeaders(BODY, NOW_S, ['old-secret', SECRET]);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(true);
  });
  it('stale timestamp beyond tolerance fails', () => {
    const headers = standardHeaders(BODY, NOW_S - 400);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('future-dated timestamp beyond tolerance fails (regression guard: a stale-only check would miss this)', () => {
    const headers = standardHeaders(BODY, NOW_S + 400);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('timestamp just inside tolerance passes', () => {
    const headers = standardHeaders(BODY, NOW_S - 299);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(true);
  });
});

describe('verifyGatewerkWebhook: standard scheme binds id and timestamp into the signed message', () => {
  it('rejects a signature that was valid for a different webhook-id (id read but not bound would let this through)', () => {
    const sig = standardSignature('wh-1', NOW_S, BODY);
    const headers = new Headers({ 'webhook-id': 'wh-2', 'webhook-timestamp': String(NOW_S), 'webhook-signature': sig });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('rejects a signature that was valid for a different webhook-timestamp, even one still inside tolerance', () => {
    const sig = standardSignature('wh-1', NOW_S, BODY);
    // NOW_S + 1 is well inside the default tolerance, so a failure here can only
    // come from the timestamp being bound into the signed message, not from the
    // tolerance check rejecting it.
    const headers = new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(NOW_S + 1), 'webhook-signature': sig });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
});

describe('verifyGatewerkWebhook: v2 scheme', () => {
  it('valid signature verifies', () => {
    const headers = v2Headers(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(true);
  });
  it('tampered body fails', () => {
    const headers = v2Headers(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY + 'x', headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('stale timestamp beyond tolerance fails', () => {
    const headers = v2Headers(BODY, NOW_S - 400);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('future-dated timestamp beyond tolerance fails (regression guard: a stale-only check would miss this)', () => {
    const headers = v2Headers(BODY, NOW_S + 400);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('timestamp just inside tolerance passes', () => {
    const headers = v2Headers(BODY, NOW_S + 299);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(true);
  });
});

describe('verifyGatewerkWebhook: v1 legacy scheme', () => {
  it('valid signature verifies', () => {
    const headers = v1Headers(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(true);
  });
  it('tampered body fails', () => {
    const headers = v1Headers(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY + 'x', headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(false);
  });
});

describe('verifyGatewerkWebhook: scheme allowlist', () => {
  it("accept: ['standard'] rejects an otherwise-valid v1 signature", () => {
    const headers = v1Headers(BODY);
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['standard'] })).toBe(false);
  });
});

describe('verifyGatewerkWebhook: junk input never throws, always fails closed', () => {
  it('no headers at all returns false', () => {
    const headers = new Headers();
    expect(() => verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).not.toThrow();
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('empty-string header values return false', () => {
    const headers = new Headers({ 'webhook-id': '', 'webhook-timestamp': '', 'webhook-signature': '' });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('a signature of the wrong length returns false (standard scheme)', () => {
    const headers = new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(NOW_S), 'webhook-signature': 'v1,short' });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('a signature of the wrong length returns false (v2 scheme)', () => {
    const headers = new Headers({ 'x-webhook-signature-v2': `t=${NOW_S},v1=deadbeef` });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('a non-numeric t returns false (v2 scheme)', () => {
    const headers = new Headers({ 'x-webhook-signature-v2': 't=not-a-number,v1=deadbeef' });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('a base64 signature where hex is expected returns false (v1 scheme)', () => {
    const base64Garbage = Buffer.from('this is not a hex digest at all').toString('base64');
    const headers = new Headers({ 'x-webhook-signature': `sha256=${base64Garbage}` });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(false);
  });
  it('garbage webhook-signature value with no v1, entries returns false', () => {
    const headers = new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(NOW_S), 'webhook-signature': 'garbage' });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
  it('malformed v2 header shape (no t=/v1= structure) returns false', () => {
    const headers = new Headers({ 'x-webhook-signature-v2': 'not-the-right-shape' });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v2'] })).toBe(false);
  });
  it('missing sha256= prefix on v1 header returns false', () => {
    const headers = new Headers({ 'x-webhook-signature': createHmac('sha256', SECRET).update(BODY).digest('hex') });
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(false);
  });
  it('never throws across a battery of malformed header shapes', () => {
    const junkHeaderSets = [
      new Headers(),
      new Headers({ 'webhook-id': '', 'webhook-timestamp': '', 'webhook-signature': '' }),
      new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(NOW_S), 'webhook-signature': 'v1,short' }),
      new Headers({ 'x-webhook-signature-v2': 't=not-a-number,v1=zz' }),
      new Headers({ 'x-webhook-signature': 'sha256=' }),
      new Headers({ 'x-webhook-signature': 'not-even-prefixed' }),
    ];
    for (const headers of junkHeaderSets) {
      expect(() => verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).not.toThrow();
      expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
    }
  });
});
