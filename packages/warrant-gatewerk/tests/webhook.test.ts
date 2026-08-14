// portfolio/packages/warrant-gatewerk/tests/webhook.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../src/webhook.js';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature', () => {
    const body = JSON.stringify({ event: 'review.decided', reviewId: 'rv-1' });
    const sig = sign(body, 'my-secret');
    expect(verifyWebhookSignature(body, sig, 'my-secret')).toBe(true);
  });

  it('returns false for a tampered signature (no throw)', () => {
    const body = JSON.stringify({ event: 'review.decided' });
    const sig = sign(body, 'my-secret');
    expect(verifyWebhookSignature(body, sig + 'x', 'my-secret')).toBe(false);
  });

  it('returns false on length mismatch (no throw)', () => {
    // 'short' is not 64 hex chars, must not throw even when lengths differ
    expect(verifyWebhookSignature('hello', 'short', 'my-secret')).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const body = 'test-body';
    const sig = sign(body, 'secret-a');
    expect(verifyWebhookSignature(body, sig, 'secret-b')).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifyWebhookSignature('body', '', 'secret')).toBe(false);
  });

  it('returns true for an empty body when signatures agree', () => {
    const sig = sign('', 'secret');
    expect(verifyWebhookSignature('', sig, 'secret')).toBe(true);
  });
});
