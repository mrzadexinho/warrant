// portfolio/packages/warrant-policy/tests/load.test.ts
import { describe, it, expect } from 'vitest';
import { loadPolicy } from '../src/load.js';

const VALID_YAML = `
version: "0.1.0"
defaults:
  path: deny
stakes:
  - id: draft-for-review
    match:
      actionKind: draft_email
    path: auto
  - id: cold-email-hiring-manager
    match:
      actionKind: send_email
      audience: cold
    path: human
protectedAudiences:
  - "*@*.gov"
  - "press@*"
caps:
  perPrincipalDaily:
    send_email: 10
`;

describe('loadPolicy', () => {
  it('parses valid YAML and returns doc + hash', () => {
    const result = loadPolicy(VALID_YAML);
    expect(result.error).toBeNull();
    expect(result.data!.doc.version).toBe('0.1.0');
    expect(result.data!.doc.defaults.path).toBe('deny');
    expect(result.data!.doc.stakes).toHaveLength(2);
    expect(result.data!.doc.protectedAudiences).toEqual(['*@*.gov', 'press@*']);
    expect(result.data!.doc.caps.perPrincipalDaily['send_email']).toBe(10);
    expect(result.data!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash is deterministic: same doc same hash', () => {
    const r1 = loadPolicy(VALID_YAML);
    const r2 = loadPolicy(VALID_YAML);
    expect(r1.data!.hash).toBe(r2.data!.hash);
  });

  // The determinism test above is satisfied by a constant. A mutation sweep replaced
  // the hash body with sha256Hex(canonicalJson({})) and every test in all nine warrant
  // packages stayed green, so nothing anywhere held the half that matters.
  //
  // policyHash is a SIGNED field on every warrant, and the certificate's claim is
  // "this action was authorized by policy version X, hash Y". If every policy hashed
  // alike, a warrant issued under a permissive policy would be byte-indistinguishable
  // from one issued under a strict policy, and a third party could not tell which
  // rules were in force. The hash would still verify. It would just mean nothing.
  describe('the hash identifies WHICH policy, not merely that there was one', () => {
    const HASH_OF = (yaml: string) => loadPolicy(yaml).data!.hash;

    it.each([
      ['a changed version', VALID_YAML.replace('"0.1.0"', '"0.2.0"')],
      ['a stakes rule loosened from human to auto', VALID_YAML.replace('path: human', 'path: auto')],
      ['a removed protected audience', VALID_YAML.replace('  - "*@*.gov"\n', '')],
      ['an added protected audience', VALID_YAML.replace('  - "press@*"', '  - "press@*"\n  - "*@*.mil"')],
      ['a raised daily cap', VALID_YAML.replace('send_email: 10', 'send_email: 1000')],
      ['a renamed stakes rule', VALID_YAML.replace('cold-email-hiring-manager', 'cold-email-anyone')],
    ])('%s changes the hash', (_label, yaml) => {
      // The premise, asserted rather than assumed: the edit really did produce a
      // different, still-valid policy. Otherwise a typo'd replace() would make this
      // pass by comparing a document with itself.
      const changed = loadPolicy(yaml);
      expect(changed.error).toBeNull();
      expect(changed.data!.doc).not.toEqual(loadPolicy(VALID_YAML).data!.doc);

      expect(changed.data!.hash).not.toBe(HASH_OF(VALID_YAML));
    });

    it('hashes the parsed document, not the YAML text', () => {
      // Reformatting is not a policy change. Flow style, reordered top-level keys and
      // different quoting all parse to the same document, so they must hash the same,
      // or every whitespace edit would invalidate the audit trail of every warrant
      // issued before it.
      const reformatted = `
caps: { perPrincipalDaily: { send_email: 10 } }
protectedAudiences: ['*@*.gov', 'press@*']
defaults: { path: deny }
version: '0.1.0'
stakes:
  - { id: draft-for-review, match: { actionKind: draft_email }, path: auto }
  - id: cold-email-hiring-manager
    path: human
    match:
      audience: cold
      actionKind: send_email
`;
      const r = loadPolicy(reformatted);
      expect(r.error).toBeNull();
      expect(r.data!.doc).toEqual(loadPolicy(VALID_YAML).data!.doc);
      expect(r.data!.hash).toBe(HASH_OF(VALID_YAML));
    });
  });

  it('returns err on malformed YAML', () => {
    const result = loadPolicy('{ bad: [unclosed');
    expect(result.data).toBeNull();
    expect(result.error!.type).toBe('validation');
    expect(result.error!.code).toBe('policy_parse_error');
  });

  it('returns err when required field missing', () => {
    const result = loadPolicy('version: "0.1.0"\ndefaults:\n  path: deny\n');
    expect(result.data).toBeNull();
    expect(result.error!.type).toBe('validation');
  });

  it('returns err when defaults.path is not literal deny', () => {
    const bad = VALID_YAML.replace('path: deny', 'path: auto');
    const result = loadPolicy(bad);
    expect(result.data).toBeNull();
    expect(result.error!.type).toBe('validation');
  });
});

// ── Unknown keys are refused, because silently stripping one widens the policy ────────────────
//
// `z.object` strips unknown keys. `evaluate.ts:57` reads an absent `match.audience` as "any
// audience". Composed, those two make a one-character typo turn a rule that requires a human into
// one that auto-approves, and `load.ts:30` hashes the PARSED document, so the certificate shows a
// self-consistent proof of a policy nobody wrote. These tests are the guard; `strictObject` in
// `schema.ts` is the fix. Every case below was verified to fail before it was written.
describe('loadPolicy refuses a document it cannot fully account for', () => {
  it('THE CASE THIS EXISTS FOR: a misspelt match key does not silently widen the rule', () => {
    // `audiance` for `audience` on the human-review rule. Under z.object this loaded clean and
    // `cold-email-hiring-manager` began matching every audience.
    const typo = VALID_YAML.replace('      audience: cold', '      audiance: cold');
    const result = loadPolicy(typo);

    expect(result.data).toBeNull();
    expect(result.error!.type).toBe('validation');
    expect(result.error!.code).toBe('policy_schema_invalid');
  });

  it('the same document without the typo still loads: the test above is not vacuous', () => {
    const result = loadPolicy(VALID_YAML);
    expect(result.error).toBeNull();
    expect(result.data!.doc.stakes[1]!.match.audience).toBe('cold');
  });

  for (const [where, bad] of [
    ['top level', VALID_YAML + 'unexpectedTopLevel: 1\n'],
    ['defaults', VALID_YAML.replace('  path: deny', '  path: deny\n  fallback: auto')],
    ['a stakes rule', VALID_YAML.replace('    path: auto', '    path: auto\n    priority: 9')],
    ['match', VALID_YAML.replace('      actionKind: draft_email', '      actionKind: draft_email\n      channel: email')],
    ['caps', VALID_YAML.replace('caps:\n', 'caps:\n  perPrincipalWeekly:\n    send_email: 70\n')],
  ] as const) {
    it(`refuses an unknown key in ${where}`, () => {
      const result = loadPolicy(bad);
      expect(result.data).toBeNull();
      expect(result.error!.code).toBe('policy_schema_invalid');
    });
  }
});

// ── A cap must name an actionKind some stakes rule mentions ──────────────────────────────────
//
// `strictObject` cannot reach inside a `z.record`, so `caps.perPrincipalDaily` was the one place
// a misspelt key still loaded clean, leaving the REAL action uncapped, since `evaluate` reads an
// absent cap as uncapped. Refusing is safe rather than opinionated: an actionKind no stakes rule
// matches already hits `default-deny`, so a cap on it could never have limited anything.
describe('loadPolicy refuses a cap that could never have applied', () => {
  it('THE CASE THIS EXISTS FOR: a misspelt cap key does not silently uncap the real action', () => {
    const typo = VALID_YAML.replace('    send_email: 10', '    send_emails: 10');
    const result = loadPolicy(typo);

    expect(result.data).toBeNull();
    expect(result.error!.code).toBe('policy_schema_invalid');
    expect(result.error!.message).toContain('send_emails');
  });

  it('the same document without the typo still loads: not vacuous', () => {
    const result = loadPolicy(VALID_YAML);
    expect(result.error).toBeNull();
    expect(result.data!.doc.caps.perPrincipalDaily['send_email']).toBe(10);
  });

  it('an empty caps block is fine: no cap is not a wrong cap', () => {
    const none = VALID_YAML.replace('  perPrincipalDaily:\n    send_email: 10\n', '  perPrincipalDaily: {}\n');
    expect(loadPolicy(none).error).toBeNull();
  });

  it('a cap on every declared kind is fine, including one only a second rule names', () => {
    const both = VALID_YAML.replace('    send_email: 10', '    send_email: 10\n    draft_email: 99');
    const result = loadPolicy(both);
    expect(result.error).toBeNull();
    expect(result.data!.doc.caps.perPrincipalDaily['draft_email']).toBe(99);
  });

  it('names every offending key, not just the first', () => {
    const two = VALID_YAML.replace('    send_email: 10', '    send_emails: 10\n    draft_emails: 5');
    const msg = loadPolicy(two).error!.message;
    expect(msg).toContain('send_emails');
    expect(msg).toContain('draft_emails');
  });
});
