// portfolio/packages/warrant-core/tests/fuzz-verify-warrant.test.ts
//
// Property-based fuzzing of verifyWarrant. Companion to issue.test.ts's example-based
// tampering tests: here the mutation itself is generated, not hand-picked, so it can
// surface tampering shapes a human wouldn't think to write by hand.
//
// Two invariants hold across every mutation strategy below:
//   1. verifyWarrant NEVER throws: it always returns a Result.
//   2. verifyWarrant returns ok(true) IFF the mutation left the warrant byte-for-byte
//      unchanged from what was actually issued. Any real change to signed content must
//      be refused. There is no "harmless mutation" case: WarrantSchema is strictObject
//      top-to-bottom (see types.ts), so even an added-unknown-key mutation is refused
//      at parse time rather than stripped-and-still-verified. See the CAVEAT at the
//      bottom of this file: this contradicts an older in-repo comment.
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { issueWarrant, verifyWarrant } from '../src/issue.js';
import type { IssueDeps } from '../src/issue.js';
import { generateKeyPair } from '../src/keys.js';
import type { ActionRequest, Verdict, Warrant } from '../src/types.js';

const SEED = 42;
const NUM_RUNS = 200;

const keys = generateKeyPair('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const FIXED_NOW = new Date('2026-07-16T10:00:00Z');
let idSeq = 0;
const deps: IssueDeps = {
  keys, now: () => FIXED_NOW,
  newId: () => `id-${++idSeq}`,
};

const request: ActionRequest = {
  id: 'req1', runId: 'run1',
  principal: { kind: 'agent', id: 'agent-01' },
  action: { kind: 'send_email', target: 'lead@example.com', params: { subject: 'Hi' } },
  context: { audience: 'cold', sentTodayByKind: {}, qaScore: 85 },
};
const autoV: Verdict = { path: 'auto', ruleId: 'draft-for-review',
  policyVersion: '0.1.0', policyHash: 'h'.repeat(64), reason: 'matched' };

function freshWarrant(): Warrant {
  const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
  if (!r.data) throw new Error('fixture issue failed');
  return r.data;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Every schema field path that participates in the signed content, expressed as either
// a single top-level key or a [parent, child] pair for the two nested strictObjects.
const TOP_LEVEL_PATHS = [
  'id', 'runId', 'policyVersion', 'policyHash', 'verdictPath', 'issuedAt', 'expiresAt',
  'nonce', 'signature',
] as const;
const NESTED_PATHS: Array<[string, string]> = [
  ['principal', 'kind'], ['principal', 'id'],
  ['action', 'kind'], ['action', 'target'], ['action', 'paramsHash'],
];

function getField(w: Warrant, path: string | [string, string]): unknown {
  if (typeof path === 'string') return (w as Record<string, unknown>)[path];
  const [parent, child] = path;
  return ((w as Record<string, unknown>)[parent] as Record<string, unknown>)[child];
}

function withField(w: Warrant, path: string | [string, string], value: unknown): Warrant {
  const clone = deepClone(w) as unknown as Record<string, unknown>;
  if (typeof path === 'string') {
    clone[path] = value;
  } else {
    const [parent, child] = path;
    (clone[parent] as Record<string, unknown>)[child] = value;
  }
  return clone as unknown as Warrant;
}

function withoutField(w: Warrant, path: string | [string, string]): Warrant {
  const clone = deepClone(w) as unknown as Record<string, unknown>;
  if (typeof path === 'string') {
    delete clone[path];
  } else {
    const [parent, child] = path;
    delete (clone[parent] as Record<string, unknown>)[child];
  }
  return clone as unknown as Warrant;
}

const anyPath = fc.oneof(
  fc.constantFrom(...TOP_LEVEL_PATHS),
  fc.constantFrom(...NESTED_PATHS),
);

describe('fuzz: verifyWarrant: field deletion', () => {
  it('deleting any single schema field never throws and never verifies ok', () => {
    fc.assert(fc.property(anyPath, (path) => {
      const w = freshWarrant();
      const mutated = withoutField(w, path);
      let threw = false;
      let result: ReturnType<typeof verifyWarrant> | undefined;
      try {
        result = verifyWarrant(mutated, keys.publicKeyHex, FIXED_NOW);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      // A field was present in every issued warrant, so deleting it is always a real
      // change: strictObject makes the required ones fail parse, and none of these
      // paths are the optional reviewRef, so ok(true) must never happen.
      expect(result?.data).not.toBe(true);
      expect(result?.error).not.toBeNull();
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyWarrant: field replacement with arbitrary JSON', () => {
  it('replacing any field with an arbitrary JSON value verifies ok IFF the value is unchanged', () => {
    fc.assert(fc.property(anyPath, fc.jsonValue(), (path, value) => {
      const w = freshWarrant();
      const original = getField(w, path);
      const mutated = withField(w, path, value);
      let threw = false;
      let result: ReturnType<typeof verifyWarrant> | undefined;
      try {
        result = verifyWarrant(mutated, keys.publicKeyHex, FIXED_NOW);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      if (deepEqual(original, value)) {
        expect(result?.data).toBe(true);
      } else {
        expect(result?.data).not.toBe(true);
        expect(result?.error).not.toBeNull();
      }
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyWarrant: one-char mutation of signature/nonce/hashes', () => {
  const HEX_LIKE_PATHS = [
    'signature', 'nonce', 'policyHash',
    ['action', 'paramsHash'] as [string, string],
  ];

  it('flipping one character of signature, nonce, policyHash, or paramsHash never verifies ok', () => {
    fc.assert(fc.property(
      fc.constantFrom(...HEX_LIKE_PATHS),
      fc.nat(), // index into the string, reduced mod length below
      (path, idxSeed) => {
        const w = freshWarrant();
        const original = getField(w, path) as string;
        if (original.length === 0) return; // nothing to flip
        const idx = idxSeed % original.length;
        const original_char = original[idx];
        // Pick a replacement character guaranteed to differ from the original.
        const replacement = original_char === 'a' ? 'b' : 'a';
        const mutatedValue = original.slice(0, idx) + replacement + original.slice(idx + 1);
        const mutated = withField(w, path, mutatedValue);
        let threw = false;
        let result: ReturnType<typeof verifyWarrant> | undefined;
        try {
          result = verifyWarrant(mutated, keys.publicKeyHex, FIXED_NOW);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        expect(result?.data).not.toBe(true);
        expect(result?.error).not.toBeNull();
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyWarrant: arbitrary timestamp strings', () => {
  const TIMESTAMP_FIELDS = ['issuedAt', 'expiresAt'] as const;

  it('replacing issuedAt/expiresAt with an arbitrary string never throws and never verifies ok', () => {
    fc.assert(fc.property(
      fc.constantFrom(...TIMESTAMP_FIELDS),
      fc.oneof(
        fc.string(),
        fc.date({ noInvalidDate: false }).map(d => d.toString()), // "Invalid Date" included
        fc.constantFrom('', 'never', 'not-a-date', '1970-01-01T00:00:00Z', '9999-99-99'),
      ),
      (field, value) => {
        const w = freshWarrant();
        const original = getField(w, field) as string;
        const mutated = withField(w, field, value);
        let threw = false;
        let result: ReturnType<typeof verifyWarrant> | undefined;
        try {
          result = verifyWarrant(mutated, keys.publicKeyHex, FIXED_NOW);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        if (value === original) {
          expect(result?.data).toBe(true);
        } else {
          expect(result?.data).not.toBe(true);
          expect(result?.error).not.toBeNull();
        }
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyWarrant: the one documented ok(true) case, and its actual boundary', () => {
  it('an exact re-clone with no mutation at all verifies ok (sanity anchor for the properties above)', () => {
    const w = freshWarrant();
    const clone = deepClone(w);
    const v = verifyWarrant(clone, keys.publicKeyHex, FIXED_NOW);
    expect(v.data).toBe(true);
    expect(v.error).toBeNull();
  });

  // CAVEAT: this test documents a DIVERGENCE from the fuzz briefing's premise, verified
  // against current source rather than assumed from the older comment in issue.test.ts
  // ("Zod strips unknown keys before canonicalJson runs, so the call never throws: and
  // the underlying valid warrant still verifies true"). That comment describes a stripping
  // schema. types.ts's WarrantSchema is z.strictObject() top-to-bottom as of this session
  // (see the comment block directly above WarrantSchema explaining the strict-vs-stripping
  // tradeoff was deliberately resolved in favor of strict, for security reasons). Under
  // z.strictObject(), an unrecognized key makes .parse() throw a ZodError, which
  // verifyWarrant's outer catch turns into err('malformed_warrant'): NOT ok(true).
  // So today there is NO mutation that adds content and still verifies ok(true); the only
  // ok(true) case is a byte-for-byte-unchanged warrant, exercised by the sanity anchor
  // above and by the identity branches of the two arbitrary-value properties above.
  it('adding an arbitrary unknown top-level key is REFUSED, not silently stripped (current behavior)', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1 }).filter(k => !(k in freshWarrant())),
      fc.jsonValue(),
      (key, value) => {
        const w = freshWarrant();
        const mutated = { ...w, [key]: value } as unknown as Warrant;
        let threw = false;
        let result: ReturnType<typeof verifyWarrant> | undefined;
        try {
          result = verifyWarrant(mutated, keys.publicKeyHex, FIXED_NOW);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        // Documented-current behavior: strictObject refuses the unknown key outright.
        expect(result?.data).not.toBe(true);
        expect(result?.error?.code).toBe('malformed_warrant');
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});
