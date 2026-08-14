import { describe, it, expect } from 'vitest';
import { GTM_STAKES } from '../src/stakes.js';
import { defaultGtmPolicy } from '../src/policy.js';

describe('GTM_STAKES', () => {
  it('COLD_EMAIL is cold-email-hiring-manager', () => {
    expect(GTM_STAKES.COLD_EMAIL).toBe('cold-email-hiring-manager');
  });
  it('REPLY is reply-existing-thread', () => {
    expect(GTM_STAKES.REPLY).toBe('reply-existing-thread');
  });
  it('DRAFT is draft-for-review', () => {
    expect(GTM_STAKES.DRAFT).toBe('draft-for-review');
  });
});

describe('defaultGtmPolicy', () => {
  it('loads without error and returns doc + 64-char hash', () => {
    const result = defaultGtmPolicy();
    expect(result.doc.version).toBe('0.1.0');
    expect(result.hash).toHaveLength(64);
  });

  it('defaults.path is deny', () => {
    expect(defaultGtmPolicy().doc.defaults.path).toBe('deny');
  });

  it('contains exactly the three GTM_STAKES rule ids', () => {
    const ids = defaultGtmPolicy().doc.stakes.map((s) => s.id);
    expect(ids).toContain(GTM_STAKES.DRAFT);
    expect(ids).toContain(GTM_STAKES.REPLY);
    expect(ids).toContain(GTM_STAKES.COLD_EMAIL);
  });

  it('draft-for-review → auto', () => {
    const rule = defaultGtmPolicy().doc.stakes.find((s) => s.id === GTM_STAKES.DRAFT);
    expect(rule?.path).toBe('auto');
    expect(rule?.match.actionKind).toBe('draft_email');
  });

  it('reply-existing-thread → auto (audience: known)', () => {
    const rule = defaultGtmPolicy().doc.stakes.find((s) => s.id === GTM_STAKES.REPLY);
    expect(rule?.path).toBe('auto');
    expect(rule?.match.audience).toBe('known');
  });

  it('cold-email-hiring-manager → human (audience: cold)', () => {
    const rule = defaultGtmPolicy().doc.stakes.find((s) => s.id === GTM_STAKES.COLD_EMAIL);
    expect(rule?.path).toBe('human');
    expect(rule?.match.audience).toBe('cold');
  });

  it('protectedAudiences contains gov and press glob patterns', () => {
    const pa = defaultGtmPolicy().doc.protectedAudiences;
    expect(pa).toContain('*@*.gov');
    expect(pa).toContain('press@*');
  });

  it('caps send_email at 10 per principal daily', () => {
    expect(defaultGtmPolicy().doc.caps.perPrincipalDaily['send_email']).toBe(10);
  });

  it('hash is stable across repeated calls', () => {
    expect(defaultGtmPolicy().hash).toBe(defaultGtmPolicy().hash);
  });
});
