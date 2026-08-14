// portfolio/packages/warrant-policy/tests/evaluate.property.test.ts
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { loadPolicy } from '../src/load.js';
import { evaluate } from '../src/evaluate.js';
import type { ActionRequest } from '@idriszade/warrant-core';

const SEED = 42;
const BASE_YAML = `
version: "0.1.0"
defaults:
  path: deny
stakes:
  - id: send-auto
    match: { actionKind: send_email }
    path: auto
protectedAudiences: []
caps:
  perPrincipalDaily:
    send_email: 100
`;
function basePolicy() {
  const r = loadPolicy(BASE_YAML);
  if (r.error) throw new Error(r.error.message);
  return r.data!;
}
const rank = (p: 'auto' | 'human' | 'deny') => p === 'deny' ? 0 : p === 'human' ? 1 : 2;
function buildReq(kind: string, target: string, sent: number): ActionRequest {
  return { id: 'p', runId: 'r', principal: { kind: 'agent', id: 'a' },
    action: { kind, target, params: {} },
    context: { sentTodayByKind: { [kind]: sent }, audience: 'cold' } };
}

describe('evaluate: property tests', () => {
  // P1 (master): protected audience always deny regardless of stakes, AND
  //              cap-at-or-above limit always deny with ruleId 'daily-cap'.
  it('P1a: protected audience always deny regardless of stakes (incl. uppercase/mixed-case)', () => {
    // Includes UPPERCASE and mixed-case to exercise the case-insensitive path.
    const casedLocal = fc.oneof(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.stringMatching(/^[A-Z]{1,8}$/),
      fc.stringMatching(/^[a-zA-Z]{1,8}$/),
    );
    const casedSub = fc.oneof(
      fc.stringMatching(/^[a-z]{1,8}$/),
      fc.stringMatching(/^[A-Z]{1,8}$/),
    );
    fc.assert(fc.property(
      fc.record({ local: casedLocal, sub: casedSub }),
      ({ local, sub }) => {
        const yaml = BASE_YAML.replace('protectedAudiences: []',
          'protectedAudiences:\n  - "*@*.gov"');
        const p = loadPolicy(yaml); if (p.error) return;
        // Target domain in .GOV / .Gov / .gov: all must be denied.
        const suffix = fc.sample(fc.constantFrom('.gov', '.GOV', '.Gov'), 1)[0] as string;
        const v = evaluate(buildReq('send_email', `${local}@${sub}${suffix}`, 0), p.data!);
        expect(v.path).toBe('deny');
        expect(v.ruleId).toBe('protected-audience');
      }
    ), { seed: SEED });
  });

  it('P1b: sentTodayByKind[kind] >= cap → always deny with ruleId daily-cap', () => {
    fc.assert(fc.property(
      fc.record({
        cap: fc.integer({ min: 1, max: 50 }),
        excess: fc.integer({ min: 0, max: 20 }),
      }),
      ({ cap, excess }) => {
        const sent = cap + excess; // always >= cap
        const yaml = BASE_YAML.replace('send_email: 100', `send_email: ${cap}`);
        const p = loadPolicy(yaml); if (p.error) return;
        const v = evaluate(buildReq('send_email', 'cto@startup.com', sent), p.data!);
        expect(v.path).toBe('deny');
        expect(v.ruleId).toBe('daily-cap');
      }
    ), { seed: SEED });
  });

  // P2 (master): adding a protectedAudiences entry or lowering any cap never
  //              increases verdict rank for any request.
  it('P2a: adding a protectedAudiences entry never increases verdict rank (incl. mixed-case targets)', () => {
    // Widened: targets and patterns include uppercase/mixed-case to cover case-bypass class.
    fc.assert(fc.property(
      fc.record({
        target: fc.constantFrom(
          'cto@acme.com', 'hr@co.io', 'x@y.org',
          'CTO@ACME.COM', 'HR@Co.IO', 'X@Y.ORG',
        ),
        pat: fc.constantFrom('*@acme.com', '*@co.io', '*@y.org'),
        kind: fc.constantFrom('send_email', 'draft_email'),
        sent: fc.integer({ min: 0, max: 5 }),
      }),
      ({ target, pat, kind, sent }) => {
        const before = [
          'version: "0.1.0"', 'defaults:', '  path: deny', 'stakes:',
          `  - id: x\n    match: { actionKind: ${kind} }\n    path: auto`,
          'protectedAudiences: []', 'caps:', `  perPrincipalDaily:\n    ${kind}: 100`,
        ].join('\n');
        const after = before.replace('protectedAudiences: []',
          `protectedAudiences:\n  - "${pat}"`);
        const pB = loadPolicy(before); const pA = loadPolicy(after);
        if (pB.error || pA.error) return;
        const r = buildReq(kind, target, sent);
        expect(rank(evaluate(r, pA.data!).path))
          .toBeLessThanOrEqual(rank(evaluate(r, pB.data!).path));
      }
    ), { seed: SEED });
  });

  it('P2b: lowering a cap never increases verdict rank', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), (sent) => {
      const high = loadPolicy(BASE_YAML);
      const low = loadPolicy(BASE_YAML.replace('send_email: 100', 'send_email: 10'));
      if (high.error || low.error) return;
      const r = buildReq('send_email', 'cto@x.com', sent);
      expect(rank(evaluate(r, low.data!).path))
        .toBeLessThanOrEqual(rank(evaluate(r, high.data!).path));
    }), { seed: SEED });
  });

  // P3 (master): a request matching no stakes rule is always deny.
  it('P3: no-stakes-match is always deny', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z_]{3,12}$/), (kind) => {
      if (kind === 'send_email') return;
      const v = evaluate(buildReq(kind, 'x@y.com', 0), basePolicy());
      expect(v.path).toBe('deny');
      expect(v.ruleId).toBe('default-deny');
    }), { seed: SEED });
  });

  // P4-dominance: when a protected-audience OR cap rule fires, the verdict is deny
  // even when a competing stakes rule of HIGHER rank (auto) is present.
  // This pins protected-vs-stakes and cap-vs-stakes ordering with generated policies.
  it('P4-dominance: protected-audience deny beats auto stakes rule', () => {
    fc.assert(fc.property(
      fc.record({
        local: fc.stringMatching(/^[a-zA-Z]{1,8}$/),
        sub: fc.stringMatching(/^[a-zA-Z]{1,8}$/),
        capHigh: fc.integer({ min: 50, max: 200 }), // cap well above 0 so cap doesn't also fire
      }),
      ({ local, sub, capHigh }) => {
        // Policy has an auto stakes rule for send_email (rank 2) AND a protected audience.
        const yaml = [
          'version: "0.1.0"', 'defaults:', '  path: deny', 'stakes:',
          '  - id: send-auto', '    match: { actionKind: send_email }', '    path: auto',
          'protectedAudiences:', '  - "*@*.gov"',
          'caps:', `  perPrincipalDaily:`, `    send_email: ${capHigh}`,
        ].join('\n');
        const p = loadPolicy(yaml); if (p.error) return;
        // Target ends in .gov (any casing) → must be denied by protected-audience,
        // not auto-approved by the stakes rule.
        const suffix = fc.sample(fc.constantFrom('.gov', '.GOV', '.Gov'), 1)[0] as string;
        const v = evaluate(buildReq('send_email', `${local}@${sub}${suffix}`, 0), p.data!);
        expect(v.path).toBe('deny');
        expect(v.ruleId).toBe('protected-audience');
      }
    ), { seed: SEED });
  });

  it('P4-dominance: cap deny beats auto stakes rule', () => {
    fc.assert(fc.property(
      fc.record({
        cap: fc.integer({ min: 1, max: 30 }),
        excess: fc.integer({ min: 0, max: 10 }),
      }),
      ({ cap, excess }) => {
        const sent = cap + excess; // always >= cap
        // Policy has an auto stakes rule for send_email AND a cap that is exceeded.
        const yaml = [
          'version: "0.1.0"', 'defaults:', '  path: deny', 'stakes:',
          '  - id: send-auto', '    match: { actionKind: send_email }', '    path: auto',
          'protectedAudiences: []',
          'caps:', `  perPrincipalDaily:`, `    send_email: ${cap}`,
        ].join('\n');
        const p = loadPolicy(yaml); if (p.error) return;
        const v = evaluate(buildReq('send_email', 'cto@startup.com', sent), p.data!);
        expect(v.path).toBe('deny');
        expect(v.ruleId).toBe('daily-cap');
      }
    ), { seed: SEED });
  });

  // P5 (extra, beyond master P1-P3): determinism
  it('P5 (extra, beyond master P1-P3): determinism, evaluate twice returns deep-equal verdict', () => {
    fc.assert(fc.property(
      fc.record({
        kind: fc.constantFrom('send_email', 'draft_email', 'other'),
        target: fc.constantFrom('a@b.com', 'x@y.gov', 'z@w.io'),
        sent: fc.integer({ min: 0, max: 20 }),
      }),
      ({ kind, target, sent }) => {
        const p = basePolicy(); const r = buildReq(kind, target, sent);
        expect(evaluate(r, p)).toEqual(evaluate(r, p));
      }
    ), { seed: SEED });
  });
});
