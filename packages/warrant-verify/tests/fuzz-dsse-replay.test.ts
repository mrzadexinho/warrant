// portfolio/packages/warrant-verify/tests/fuzz-dsse-replay.test.ts
//
// Property-based fuzzing of two verifier surfaces: verifyDsse (the envelope/signature layer)
// and verifyChain/replayRun (the ledger-chain layer). Companion to dsse.test.ts, chain-linkage
// test.ts, and replay.test.ts's example-based tests: here the mutation is generated, not
// hand-picked.
//
// Shared invariant across every property below: these functions NEVER throw. Every failure
// mode is a typed Result error, because a verifier that throws on attacker-controlled input
// stops being a verifier and starts being a crash oracle.
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { KeyPair } from '@idriszade/warrant-core';
import { canonicalJson, generateKeyPair, signBytes } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import type { DsseEnvelope } from '../src/dsse.js';
import { exportDsse, verifyDsse } from '../src/dsse.js';
import { buildStatement, IN_TOTO_STATEMENT_TYPE, WARRANT_PREDICATE_TYPE } from '../src/intoto.js';
import { verifyChain } from '../src/chain.js';
import { replayRun } from '../src/replay.js';

const SEED = 42;
const NUM_RUNS = 200;

const KA = generateKeyPair('a'.repeat(64));
const P = { kind: 'agent' as const, id: 'a' };
const PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mkChain(): LedgerEntry[] {
  const b1 = { seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r',
    at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P, payload: { x: 1 } };
  const h1 = entryHash(b1);
  const b2 = { seq: 2, prevHash: h1, runId: 'r',
    at: '2026-07-16T00:01:00Z', event: 'warrant.issued' as const, principal: P, payload: { x: 2 } };
  return [{ ...b1, hash: h1 }, { ...b2, hash: entryHash(b2) }];
}

// PAE construction duplicated test-local only, mirroring dsse.ts's private helper and
// dsse.test.ts's own copy: not part of the public API, and CLAUDE.md forbids a second
// canonicalJson, not a second test-local PAE builder used purely to sign fixtures.
function paeBytes(pt: string, body: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const ptBytes = enc.encode(pt);
  const prefix = enc.encode(`DSSEv1 ${ptBytes.length} ${pt} ${body.length} `);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}
function signRawBody(bodyStr: string, keys: KeyPair): DsseEnvelope {
  const body = new TextEncoder().encode(bodyStr);
  const sig = signBytes(paeBytes(PAYLOAD_TYPE, body), keys.privateKeyHex);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(body).toString('base64'),
    signatures: [{ keyid: keys.publicKeyHex, sig }],
  };
}
function signObject(obj: unknown, keys: KeyPair): DsseEnvelope {
  return signRawBody(canonicalJson(obj), keys);
}
function signObjectAs(obj: unknown, payloadType: string, keys: KeyPair): DsseEnvelope {
  const body = new TextEncoder().encode(canonicalJson(obj));
  return {
    payloadType,
    payload: Buffer.from(body).toString('base64'),
    signatures: [{ keyid: keys.publicKeyHex, sig: signBytes(paeBytes(payloadType, body), keys.privateKeyHex) }],
  } as unknown as DsseEnvelope;
}

// ── verifyDsse fuzz ──────────────────────────────────────────────────────────────────────

describe('fuzz: verifyDsse: arbitrary payloadType strings', () => {
  it('only the exact declared payloadType can verify; every other value is refused, never thrown', () => {
    fc.assert(fc.property(fc.string(), (pt) => {
      const chain = mkChain();
      const env = signObjectAs(buildStatement(chain), pt, KA);
      let threw = false;
      let result: ReturnType<typeof verifyDsse> | undefined;
      try {
        result = verifyDsse(env, KA.publicKeyHex);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      if (pt === PAYLOAD_TYPE) {
        expect(result?.error).toBeNull();
        expect(result?.data).toEqual(chain);
      } else {
        expect(result?.data).toBeNull();
        expect(result?.error?.code).toBe('signature_invalid');
      }
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyDsse: truncated/garbled base64 payload', () => {
  it('any corruption of the payload string is refused, never thrown', () => {
    fc.assert(fc.property(
      fc.nat({ max: 500 }),
      fc.string({ maxLength: 50 }),
      (n, garbage) => {
        const chain = mkChain();
        const env = exportDsse(chain, KA);
        const original = env.payload;
        // Truncate to a bounded prefix, then optionally splice in garbage: covers both
        // "shorter" (truncated base64) and "same-ish length but corrupted" mutation shapes.
        const cut = original.slice(0, n % (original.length + 1));
        const mutatedPayload = cut + garbage;
        const mutated: DsseEnvelope = { ...env, payload: mutatedPayload };
        let threw = false;
        let result: ReturnType<typeof verifyDsse> | undefined;
        try {
          result = verifyDsse(mutated, KA.publicKeyHex);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        if (mutatedPayload === original) {
          expect(result?.error).toBeNull();
        } else {
          expect(result?.data).toBeNull();
          expect(result?.error).not.toBeNull();
        }
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyDsse: arbitrary JSON bodies, validly re-signed', () => {
  // Cheap structural check for "could plausibly be a WarrantStatement": deliberately looser
  // than parseStatement's real rules (no subject-digest binding check), so it only tells us
  // when a rejection is UNSURPRISING, never asserts a fluke-shaped body must verify ok.
  function isPlausibleStatement(v: unknown): boolean {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    if (o._type !== IN_TOTO_STATEMENT_TYPE) return false;
    if (o.predicateType !== WARRANT_PREDICATE_TYPE) return false;
    if (!Array.isArray(o.subject) || o.subject.length !== 1) return false;
    const predicate = o.predicate;
    if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) return false;
    if (!Array.isArray((predicate as Record<string, unknown>).entries)) return false;
    return true;
  }

  it('an arbitrary validly-signed JSON body never throws; a body that cannot plausibly be a statement is always refused', () => {
    fc.assert(fc.property(fc.jsonValue(), (body) => {
      const env = signObject(body, KA);
      let threw = false;
      let result: ReturnType<typeof verifyDsse> | undefined;
      try {
        result = verifyDsse(env, KA.publicKeyHex);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).toBeDefined();
      if (!isPlausibleStatement(body)) {
        expect(result?.data).toBeNull();
        expect(result?.error).not.toBeNull();
      }
      // A fluke-plausible body is left unasserted on the ok/error axis: it still has to pass
      // the subject-digest binding parseStatement enforces, which this cheap check does not
      // model. The never-throws assertion above is what this property exists to pin.
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyDsse: signatures array of arbitrary length', () => {
  it('any length other than exactly 1 is refused before the signature is even checked', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ keyid: fc.string(), sig: fc.string() }), { minLength: 0, maxLength: 6 }),
      (sigs) => {
        const chain = mkChain();
        const env = exportDsse(chain, KA);
        const mutated = { ...env, signatures: sigs } as unknown as DsseEnvelope;
        let threw = false;
        let result: ReturnType<typeof verifyDsse> | undefined;
        try {
          result = verifyDsse(mutated, KA.publicKeyHex);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(result).toBeDefined();
        if (sigs.length !== 1) {
          expect(result?.data).toBeNull();
          expect(result?.error?.code).toBe('signature_invalid');
        } else {
          const real = env.signatures[0];
          const isRealSig = sigs[0]!.keyid === real.keyid && sigs[0]!.sig === real.sig;
          if (isRealSig) {
            expect(result?.error).toBeNull();
          } else {
            expect(result?.error?.code).toBe('signature_invalid');
          }
        }
      },
    ), { seed: SEED, numRuns: NUM_RUNS });
  });
});

// ── verifyChain / replayRun fuzz ────────────────────────────────────────────────────────

const RUN = 'run-fuzz';
const AT = '2026-07-16T00:00:00Z';
const NOW = () => new Date('2026-07-16T12:00:00.000Z');

function freshFuzzChain(): LedgerEntry[] {
  const items = [
    { runId: RUN, at: AT, event: 'warrant.requested' as const, principal: P,
      payload: { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com' } },
    { runId: RUN, at: AT, event: 'policy.evaluated' as const, principal: P,
      payload: { requestId: 'req-1', ruleId: 'r', path: 'auto' } },
  ];
  const entries: LedgerEntry[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < items.length; i++) {
    const base = { ...items[i]!, seq: i + 1, prevHash: prev };
    const hash = entryHash(base);
    entries.push({ ...base, hash });
    prev = hash;
  }
  return entries;
}

// Every field this fuzz targets, as [entryIndex, 'top'|'payload', fieldName]. 'top' covers
// seq/prevHash/hash: the three chain-linkage fields the briefing calls out; 'payload' covers
// one representative key from each of the two fixture entries' payloads.
const MUTATION_PATHS = [
  [0, 'top', 'seq'], [0, 'top', 'prevHash'], [0, 'top', 'hash'],
  [0, 'payload', 'requestId'], [0, 'payload', 'actionKind'], [0, 'payload', 'target'],
  [1, 'top', 'seq'], [1, 'top', 'prevHash'], [1, 'top', 'hash'],
  [1, 'payload', 'requestId'], [1, 'payload', 'ruleId'], [1, 'payload', 'path'],
] as const;

function getAtPath(entries: LedgerEntry[], index: number, kind: 'top' | 'payload', field: string): unknown {
  const e = entries[index] as unknown as Record<string, unknown>;
  if (kind === 'top') return e[field];
  return (e.payload as Record<string, unknown>)[field];
}

function withMutation(
  entries: LedgerEntry[], index: number, kind: 'top' | 'payload', field: string,
  op: 'delete' | 'replace', value?: unknown,
): LedgerEntry[] {
  const clone = deepClone(entries) as unknown as Record<string, unknown>[];
  const e = clone[index]!;
  const target = kind === 'top' ? e : (e.payload as Record<string, unknown>);
  if (op === 'delete') delete target[field];
  else target[field] = value;
  return clone as unknown as LedgerEntry[];
}

describe('fuzz: verifyChain/replayRun: deleting seq, prevHash, hash, or a payload key from one entry', () => {
  it('always breaks the chain, never throws, and replayRun mirrors the same chain_broken error', () => {
    fc.assert(fc.property(fc.constantFrom(...MUTATION_PATHS), (path) => {
      const [index, kind, field] = path;
      const chain = freshFuzzChain();
      const mutated = withMutation(chain, index, kind, field, 'delete');
      let threwChain = false;
      let threwReplay = false;
      let cv: ReturnType<typeof verifyChain> | undefined;
      let rr: ReturnType<typeof replayRun> | undefined;
      try { cv = verifyChain(mutated); } catch { threwChain = true; }
      try { rr = replayRun(mutated, RUN, NOW); } catch { threwReplay = true; }
      expect(threwChain).toBe(false);
      expect(threwReplay).toBe(false);
      expect(cv?.data).not.toBe(true);
      expect(cv?.error?.code).toBe('chain_broken');
      expect(rr?.data).toBeNull();
      expect(rr?.error?.code).toBe('chain_broken');
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});

describe('fuzz: verifyChain/replayRun: replacing seq, prevHash, hash, or a payload key with an arbitrary JSON value', () => {
  it('breaks the chain UNLESS the replacement is byte-identical to what was there, and replayRun always mirrors verifyChain', () => {
    fc.assert(fc.property(fc.constantFrom(...MUTATION_PATHS), fc.jsonValue(), (path, value) => {
      const [index, kind, field] = path;
      const chain = freshFuzzChain();
      const original = getAtPath(chain, index, kind, field);
      const mutated = withMutation(chain, index, kind, field, 'replace', value);
      let threwChain = false;
      let threwReplay = false;
      let cv: ReturnType<typeof verifyChain> | undefined;
      let rr: ReturnType<typeof replayRun> | undefined;
      try { cv = verifyChain(mutated); } catch { threwChain = true; }
      try { rr = replayRun(mutated, RUN, NOW); } catch { threwReplay = true; }
      expect(threwChain).toBe(false);
      expect(threwReplay).toBe(false);
      if (deepEqual(original, value)) {
        expect(cv?.data).toBe(true);
        expect(cv?.error).toBeNull();
        expect(rr?.error).toBeNull();
      } else {
        expect(cv?.data).not.toBe(true);
        expect(cv?.error?.code).toBe('chain_broken');
        expect(rr?.data).toBeNull();
        expect(rr?.error?.code).toBe('chain_broken');
      }
    }), { seed: SEED, numRuns: NUM_RUNS });
  });
});
