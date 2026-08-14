// Webhook guards a mutation sweep found unheld, plus the ones it found REDUNDANT.
//
// webhook.ts is the door a third party knocks on, so a guard that stops existing here
// is a guard on who gets to tell this system a human approved something. The sweep
// flagged nine survivors in this file; measuring them properly turned three of the
// nine into "already held, but only as a pair" and two into "cannot fail on any input".
// Both of those are recorded here rather than papered over with a test that passes for
// a reason it does not state.
//
// Held only JOINTLY, so single deletion measured nothing (existing tests in
// webhook-verify.test.ts already cover them):
//   safeEqual's `a.length === b.length` and verifyV1's `!header`, each paired with
//   verifyGatewerkWebhook's outer catch. Removing either alone turns a throw into a
//   caught throw and the answer is false either way; removing both lets the throw out,
//   and the existing wrong-length and tampered-body tests go red.
//
// REDUNDANT, deliberately untested rather than given a test that cannot fail:
//   verifyV2's `if (!header) return false`. The regex on the next line receives null,
//   String()s it to "null", and fails to match. Confirmed by deleting it together with
//   the outer catch: still no throw, still false. Honest defensive code, but not a
//   property a test can hold.
//
// `withinTolerance`'s `!Number.isFinite(tsSeconds)` is NOT redundant: "Infinity <= x is
// false" holds only while x is finite. `toleranceMs` is caller-supplied, and at Infinity
// the comparison becomes `Infinity <= Infinity`, which is TRUE. The guard is the only thing
// rejecting an overflowing timestamp in that configuration, so it is load-bearing and is
// held by the tests at the bottom of this file.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGatewerkWebhook } from '../src/webhook.js';

const SECRET = 'wh-secret';
const BODY = JSON.stringify({ type: 'review.decided', review_id: 'rv-1' });
const NOW_MS = new Date('2026-07-26T12:00:00.000Z').getTime();
const NOW = () => new Date(NOW_MS);
const NOW_S = Math.floor(NOW_MS / 1000);

/** Signs the standard scheme's message using the timestamp header VERBATIM. */
function standardSigFor(id: string, tsHeader: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${id}\n${tsHeader}\n${body}`).digest('base64');
}

describe('the standard scheme requires every header it signs over', () => {
  it('an in-window delivery with no webhook-signature is false, and does not throw', () => {
    // Held only jointly with the outer catch, and the sweep's single deletions of each
    // measured nothing, so this is stated as the joint property it is. The existing
    // no-headers test does not reach here: with no timestamp, Number(null) is 0 and the
    // tolerance check returns false long before the missing signature is dereferenced.
    // A delivery carrying a VALID in-window timestamp gets past that and reaches
    // `sigHeader.split(' ')` on null.
    const headers = new Headers({ 'webhook-id': 'wh-1', 'webhook-timestamp': String(NOW_S) });

    expect(() => verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).not.toThrow();
    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });

  it('a fractional timestamp inside the window is rejected even with a genuine signature', () => {
    // `Number.isInteger(ts)` sits in front of the tolerance check, and only the
    // tolerance half had coverage. The signature here is computed over this exact
    // header value, and 0.5s from now is well inside the 300s window, so the ONLY
    // thing that can reject it is the integer check. Standard Webhooks specifies
    // integer seconds; accepting anything Number() will parse is how a verifier ends
    // up disagreeing with the sender about what was signed.
    const tsHeader = `${NOW_S}.5`;
    const headers = new Headers({
      'webhook-id': 'wh-1',
      'webhook-timestamp': tsHeader,
      'webhook-signature': `v1,${standardSigFor('wh-1', tsHeader, BODY)}`,
    });

    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });

  it('the same delivery with an integer timestamp verifies, so the check is not rejecting everything', () => {
    const tsHeader = String(NOW_S);
    const headers = new Headers({
      'webhook-id': 'wh-1',
      'webhook-timestamp': tsHeader,
      'webhook-signature': `v1,${standardSigFor('wh-1', tsHeader, BODY)}`,
    });

    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(true);
  });

  it('a correct signature with no v1, version prefix is not accepted', () => {
    // webhook-signature is a space-separated list of versioned entries, and the
    // `v1,` filter is what makes it a list of VERSIONED ones. Without that
    // requirement a bare digest is accepted, which means a future v2 entry format
    // would be fed to the v1 comparison instead of being ignored until this file
    // learns to read it. The digest below is byte-for-byte the one the prefixed
    // entry in the test above carries, so nothing but the missing prefix differs.
    const tsHeader = String(NOW_S);
    const headers = new Headers({
      'webhook-id': 'wh-1',
      'webhook-timestamp': tsHeader,
      'webhook-signature': standardSigFor('wh-1', tsHeader, BODY),
    });

    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW })).toBe(false);
  });
});

describe('the v1 scheme names its digest algorithm and is held to it', () => {
  it('a sha512= prefix carrying a valid sha256 digest is rejected', () => {
    // `startsWith('sha256=')` was the half of that guard with no coverage: the
    // existing test drops the prefix entirely, and slice(7) then chops seven
    // characters off the digest so it fails for the wrong reason. 'sha512=' is also
    // seven characters, so slice(7) hands the comparison a perfectly valid sha256
    // digest and it matches. Without the prefix check this delivery is accepted
    // under an algorithm nobody computed it with.
    const digest = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const headers = new Headers({ 'x-webhook-signature': `sha512=${digest}` });

    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(false);
  });

  it('the same digest under sha256= verifies, so the prefix check is not rejecting everything', () => {
    const digest = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const headers = new Headers({ 'x-webhook-signature': `sha256=${digest}` });

    expect(verifyGatewerkWebhook({ rawBody: BODY, headers, secret: SECRET, now: NOW, accept: ['v1'] })).toBe(true);
  });
});

describe('withinTolerance refuses a timestamp that is not a finite number', () => {
  /** Signs the v2 message, which is `${tsStr}.${rawBody}` in hex, using the header verbatim. */
  function v2SigFor(tsStr: string, body: string): string {
    return createHmac('sha256', SECRET).update(`${tsStr}.${body}`).digest('hex');
  }

  it('a v2 timestamp that overflows to Infinity is rejected when tolerance is disabled', () => {
    // Reachable, and only here: the v2 regex accepts `\d+` of ANY length, and
    // Number('9'.repeat(400)) is Infinity. verifyStandard cannot reach this state
    // because Number.isInteger(Infinity) is false one line earlier.
    //
    // Under a finite tolerance the comparison below the guard rejects this anyway,
    // which is why a single deletion measured nothing and the guard was filed as
    // redundant. toleranceMs is caller-supplied: at Infinity the comparison is
    // `Infinity <= Infinity`, which is true, and the guard is the only thing left
    // saying no. The signature is VALID over this exact header, so nothing else in
    // the function is doing the rejecting.
    const tsStr = '9'.repeat(400);
    const headers = new Headers({ 'x-webhook-signature-v2': `t=${tsStr},v1=${v2SigFor(tsStr, BODY)}` });

    expect(
      verifyGatewerkWebhook({
        rawBody: BODY,
        headers,
        secret: SECRET,
        now: NOW,
        toleranceMs: Number.POSITIVE_INFINITY,
        accept: ['v2'],
      }),
    ).toBe(false);
  });

  it('a real timestamp under the same disabled tolerance is accepted', () => {
    // The positive half: without it, a guard tightened into rejecting every v2
    // delivery would pass the test above and look like coverage.
    const tsStr = String(NOW_S);
    const headers = new Headers({ 'x-webhook-signature-v2': `t=${tsStr},v1=${v2SigFor(tsStr, BODY)}` });

    expect(
      verifyGatewerkWebhook({
        rawBody: BODY,
        headers,
        secret: SECRET,
        now: NOW,
        toleranceMs: Number.POSITIVE_INFINITY,
        accept: ['v2'],
      }),
    ).toBe(true);
  });
});
