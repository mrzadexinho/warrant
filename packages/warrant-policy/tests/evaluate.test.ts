// portfolio/packages/warrant-policy/tests/evaluate.test.ts
import { describe, it, expect } from 'vitest';
import { loadPolicy } from '../src/load.js';
import { evaluate } from '../src/evaluate.js';
import type { ActionRequest } from '@idriszade/warrant-core';

const YAML = `
version: "0.1.0"
defaults:
  path: deny
stakes:
  - id: draft-for-review
    match: { actionKind: draft_email }
    path: auto
  - id: cold-email-hiring-manager
    match: { actionKind: send_email, audience: cold }
    path: human
  - id: reply-existing-thread
    match: { actionKind: send_email, audience: known }
    path: auto
protectedAudiences: ["*@*.gov", "press@*"]
caps:
  perPrincipalDaily:
    send_email: 10
`;

function policy() {
  const r = loadPolicy(YAML);
  if (r.error) throw new Error(r.error.message);
  return r.data!;
}
function req(
  overrides: Partial<ActionRequest['action']> & { context?: Record<string, unknown> },
): ActionRequest {
  return {
    id: 'req-1', runId: 'run-1',
    principal: { kind: 'agent', id: 'agent-1' },
    action: { kind: overrides.kind ?? 'send_email', target: overrides.target ?? 'cto@startup.com', params: {} },
    context: overrides.context ?? { sentTodayByKind: {}, audience: 'cold' },
  };
}

describe('evaluate', () => {
  it('protected audience beats matching stakes rule', () => {
    const v = evaluate(req({ target: 'lobbyist@senate.gov', context: { sentTodayByKind: {}, audience: 'cold' } }), policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('protected-audience');
  });
  it('cap beats matching stakes rule', () => {
    const v = evaluate(req({ context: { sentTodayByKind: { send_email: 10 }, audience: 'cold' } }), policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('daily-cap');
  });
  it('first stakes rule wins: cold send_email → human', () => {
    const v = evaluate(req({ context: { sentTodayByKind: {}, audience: 'cold' } }), policy());
    expect(v.path).toBe('human'); expect(v.ruleId).toBe('cold-email-hiring-manager');
  });
  it('second stakes rule: known send_email → auto', () => {
    const v = evaluate(req({ context: { sentTodayByKind: {}, audience: 'known' } }), policy());
    expect(v.path).toBe('auto'); expect(v.ruleId).toBe('reply-existing-thread');
  });
  it('audience-optional stake matches any audience: draft_email', () => {
    const v = evaluate(req({ kind: 'draft_email', target: 'any@co.com', context: { sentTodayByKind: {} } }), policy());
    expect(v.path).toBe('auto'); expect(v.ruleId).toBe('draft-for-review');
  });
  it('no stakes match → default-deny', () => {
    const v = evaluate(req({ kind: 'unknown_action', target: 'x@y.com', context: {} }), policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('default-deny');
  });
  it('verdict carries policyVersion and policyHash', () => {
    const p = policy(); const v = evaluate(req({}), p);
    expect(v.policyVersion).toBe('0.1.0'); expect(v.policyHash).toBe(p.hash);
  });
  it('determinism: evaluate twice yields deep-equal verdicts', () => {
    const p = policy(); const r = req({});
    expect(evaluate(r, p)).toEqual(evaluate(r, p));
  });

  // Case-insensitive protected-audience checks (issue 1)
  it('uppercase domain denied: ceo@AGENCY.GOV matches *@*.gov', () => {
    const v = evaluate(req({ target: 'ceo@AGENCY.GOV', context: { sentTodayByKind: {}, audience: 'cold' } }), policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('protected-audience');
  });
  it('mixed-case local denied: Press@Foo.COM matches press@*', () => {
    const v = evaluate(req({ target: 'Press@Foo.COM', context: { sentTodayByKind: {}, audience: 'cold' } }), policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('protected-audience');
  });

  // Fail-closed guard tests (issue 2)
  it('non-string target → deny malformed-request', () => {
    const r = req({});
    // Force a non-string target past the TypeScript type boundary (runtime guard).
    (r.action as Record<string, unknown>)['target'] = 42;
    const v = evaluate(r, policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('malformed-request');
  });
  it('null context → deny malformed-request', () => {
    const r = req({});
    (r as unknown as Record<string, unknown>)['context'] = null;
    const v = evaluate(r, policy());
    expect(v.path).toBe('deny'); expect(v.ruleId).toBe('malformed-request');
  });
  it('context without sentTodayByKind → proceeds normally (not malformed)', () => {
    // Missing sentTodayByKind means zero sent: not a malformed request.
    const v = evaluate(req({ context: { audience: 'cold' } }), policy());
    expect(v.path).toBe('human'); expect(v.ruleId).toBe('cold-email-hiring-manager');
  });
});

// Panel findings, pre-publication review: the DP matcher's cost is driven by the
// caller's target string, and the caps check trusted a context value it never checked.
describe('fail-closed guards against hostile request shapes', () => {
  const doc = {
    version: '0.1.0',
    protectedAudiences: ['*@protected.example'],
    caps: { perPrincipalDaily: { send_email: 5 } },
    stakes: [{ id: 'anything-goes', match: {}, path: 'auto' as const }],
  };
  const policy = { doc: doc as never, hash: 'h'.repeat(64) };
  const req = (over: Record<string, unknown>) => ({
    id: 'r1', runId: 'run1', principal: { kind: 'agent' as const, id: 'a1' },
    action: { kind: 'send_email', target: 'x@example.com', params: {} },
    context: {}, ...over,
  });

  it('denies an oversized action.target as malformed instead of paying O(P*T) for it', () => {
    const v = evaluate(req({
      action: { kind: 'send_email', target: 'a'.repeat(100_000), params: {} },
    }) as never, policy);
    expect(v.path).toBe('deny');
    expect(v.ruleId).toBe('malformed-request');
  });

  it('a target at the length cap still evaluates normally', () => {
    const v = evaluate(req({
      action: { kind: 'send_email', target: 'a'.repeat(4096), params: {} },
    }) as never, policy);
    expect(v.ruleId).not.toBe('malformed-request');
  });

  it('denies a non-numeric sentTodayByKind value as malformed instead of skipping the cap', () => {
    const v = evaluate(req({
      context: { sentTodayByKind: { send_email: {} } },
    }) as never, policy);
    expect(v.path).toBe('deny');
    expect(v.ruleId).toBe('malformed-request');
  });

  it('NaN in sentTodayByKind is malformed, never a cap bypass', () => {
    const v = evaluate(req({
      context: { sentTodayByKind: { send_email: Number.NaN } },
    }) as never, policy);
    expect(v.path).toBe('deny');
    expect(v.ruleId).toBe('malformed-request');
  });
});
