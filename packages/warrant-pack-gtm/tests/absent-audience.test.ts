// The shipped pack must be safe against the absent-audience footgun: a stakes rule that
// requires a key does not match when the key is absent, so what an agent reaches by
// OMITTING context.audience is whatever sits beneath the send_email rules. In this pack
// that must be default deny, never an auto rule. An authored catch-all
// (match: {actionKind: send_email} alone, path: auto) would make omission an escape hatch
// from human review; this test is what turns adding one into a visible decision.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, loadPolicy } from '@idriszade/warrant-policy';
import type { ActionRequest } from '@idriszade/warrant-core';

const yaml = readFileSync(new URL('../assets/gtm-default.yaml', import.meta.url), 'utf8');

function req(context: Record<string, unknown>): ActionRequest {
  return {
    id: 'r1', runId: 'run1',
    principal: { kind: 'agent', id: 'a1' },
    action: { kind: 'send_email', target: 'someone@example.com', params: {} },
    context,
  };
}

describe('gtm-default.yaml: absent audience cannot reach an auto path', () => {
  const loaded = loadPolicy(yaml);
  const policy = loaded.data!;

  it('sanity: the pack loads', () => {
    expect(loaded.error).toBeNull();
  });

  it('send_email with audience present routes as authored (cold -> human)', () => {
    const v = evaluate(req({ audience: 'cold', sentTodayByKind: {} }), policy);
    expect(v.path).toBe('human');
    expect(v.ruleId).toBe('cold-email-hiring-manager');
  });

  it('send_email with audience ABSENT falls to default deny, never an auto rule', () => {
    const v = evaluate(req({ sentTodayByKind: {} }), policy);
    expect(v.path).toBe('deny');
    expect(v.ruleId).toBe('default-deny');
  });

  it('send_email with an unrecognized audience also denies', () => {
    const v = evaluate(req({ audience: 'something-else', sentTodayByKind: {} }), policy);
    expect(v.path).toBe('deny');
  });
});
