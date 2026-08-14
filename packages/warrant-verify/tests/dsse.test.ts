// Tests exportDsse/verifyDsse against C9: the DSSE payload is now an in-toto Statement, not a
// bare LedgerEntry[]. Sections: envelope shape + subject digest (lines ~55-80), round trip and
// tamper/wrong-key rejection (~82-99), a validly re-signed wrong _type/predicateType statement
// is rejected: proves parseStatement runs, not just the signature check (~101-124), and a
// "garbage inputs never throw" sweep (~126-185): bad base64, non-JSON, non-object JSON, and a
// malformed-but-validly-signed statement missing subject/predicate.entries or with wrong types.
import { describe, expect, it } from 'vitest';
import type { KeyPair } from '@idriszade/warrant-core';
import { canonicalJson, generateKeyPair, signBytes } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import type { DsseEnvelope } from '../src/dsse.js';
import { exportDsse, verifyDsse } from '../src/dsse.js';
import { buildStatement, IN_TOTO_STATEMENT_TYPE, WARRANT_PREDICATE_TYPE } from '../src/intoto.js';

const KA = generateKeyPair('a'.repeat(64));
const KB = generateKeyPair('b'.repeat(64));
const P = { kind: 'agent' as const, id: 'a' };
const PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;

function mkChain(): LedgerEntry[] {
  const b1 = { seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r',
    at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P, payload: { x: 1 } };
  const h1 = entryHash(b1);
  const b2 = { seq: 2, prevHash: h1, runId: 'r',
    at: '2026-07-16T00:01:00Z', event: 'warrant.issued' as const, principal: P, payload: { x: 2 } };
  return [{ ...b1, hash: h1 }, { ...b2, hash: entryHash(b2) }];
}

function decodePayload(payload: string): unknown {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

// PAE construction duplicated from dsse.ts, test-local only: lets tests sign a hand-built
// statement (or raw bytes) validly, so a rejection proves parseStatement ran, not merely that
// the signature check works. Mirrors the private paeBytes helper; not part of the public API.
// It returns bytes and is signed with signBytes for the same reason the implementation does:
// a test helper that still signed a decoded string would keep passing while proving nothing.
function paeBytes(pt: string, body: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const ptBytes = enc.encode(pt);
  const prefix = enc.encode(`DSSEv1 ${ptBytes.length} ${pt} ${body.length} `);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

// Annotated as DsseEnvelope so the signatures literal is contextually typed as the 1-tuple
// the envelope declares. Without it every call site widens to {keyid,sig}[] and would need
// its own cast, which is exactly the kind of per-call-site cast that hides real drift.
function signRawBody(bodyStr: string, keys: KeyPair): DsseEnvelope {
  const body = new TextEncoder().encode(bodyStr);
  const sig = signBytes(paeBytes(PAYLOAD_TYPE, body), keys.privateKeyHex);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(body).toString('base64'),
    signatures: [{ keyid: keys.publicKeyHex, sig }],
  };
}

function signObject(obj: unknown, keys: KeyPair) {
  return signRawBody(canonicalJson(obj), keys);
}

/** Signs a statement under a DECLARED payloadType, so the envelope's own header can lie. */
function signObjectAs(obj: unknown, payloadType: string, keys: KeyPair) {
  const body = new TextEncoder().encode(canonicalJson(obj));
  return {
    payloadType,
    payload: Buffer.from(body).toString('base64'),
    signatures: [{ keyid: keys.publicKeyHex, sig: signBytes(paeBytes(payloadType, body), keys.privateKeyHex) }],
  } as unknown as Parameters<typeof verifyDsse>[0];
}

describe('DSSE envelope is an in-toto Statement (C9)', () => {
  it('payloadType is application/vnd.in-toto+json', () => {
    const env = exportDsse(mkChain(), KA);
    expect(env.payloadType).toBe(PAYLOAD_TYPE);
    expect(env.signatures[0].keyid).toBe(KA.publicKeyHex);
  });

  it('decoded payload has the right _type, predicateType, and subject digest', () => {
    const chain = mkChain();
    const env = exportDsse(chain, KA);
    const statement = decodePayload(env.payload) as Record<string, unknown>;
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(WARRANT_PREDICATE_TYPE);
    const subject = statement.subject as Array<{ name: string; digest: { sha256: string } }>;
    expect(subject[0]!.name).toBe('warrant-ledger-chain');
    expect(subject[0]!.digest.sha256).toBe(chain.at(-1)!.hash);
  });

  it('empty entries: subject digest is GENESIS_PREV_HASH', () => {
    const env = exportDsse([], KA);
    const statement = decodePayload(env.payload) as { subject: Array<{ digest: { sha256: string } }> };
    expect(statement.subject[0]!.digest.sha256).toBe(GENESIS_PREV_HASH);
  });

  it('round trip: verifyDsse(exportDsse(entries)) returns the same entries', () => {
    const chain = mkChain();
    const r = verifyDsse(exportDsse(chain, KA), KA.publicKeyHex);
    expect(r.error).toBeNull();
    expect(r.data).toEqual(chain);
  });

  it('signature_invalid with wrong key', () => {
    expect(verifyDsse(exportDsse(mkChain(), KA), KB.publicKeyHex).error?.code)
      .toBe('signature_invalid');
  });

  it('signature_invalid when payload altered (tampered, not re-signed)', () => {
    const env = { ...exportDsse(mkChain(), KA),
      payload: Buffer.from('{"x":0}').toString('base64') };
    expect(verifyDsse(env, KA.publicKeyHex).error?.code).toBe('signature_invalid');
  });

  it('rejects a wrong _type even when validly re-signed', () => {
    const chain = mkChain();
    const bad = {
      _type: 'https://example.com/NotInToto/v1',
      subject: [{ name: 'warrant-ledger-chain', digest: { sha256: chain.at(-1)!.hash } }],
      predicateType: WARRANT_PREDICATE_TYPE,
      predicate: { entries: chain },
    };
    const env = signObject(bad, KA);
    expect(verifyDsse(env, KA.publicKeyHex).error?.code).toBe('signature_invalid');
  });

  it('rejects a wrong predicateType even when validly re-signed', () => {
    const chain = mkChain();
    const bad = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: 'warrant-ledger-chain', digest: { sha256: chain.at(-1)!.hash } }],
      predicateType: 'https://example.com/NotWarrant/v1',
      predicate: { entries: chain },
    };
    const env = signObject(bad, KA);
    expect(verifyDsse(env, KA.publicKeyHex).error?.code).toBe('signature_invalid');
  });

  describe('the signature binds payload BYTES, not the text they decode to', () => {
    /** A chain whose canonical JSON contains U+FFFD, so the payload bytes carry EF BF BD. */
    function mkChainWithReplacementChar(): LedgerEntry[] {
      const b1 = { seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r',
        at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P,
        payload: { note: 'before�after' } };
      return [{ ...b1, hash: entryHash(b1) }];
    }

    it('a mutated payload that UTF-8-decodes identically is rejected', () => {
      const env = exportDsse(mkChainWithReplacementChar(), KA);
      // Positive control on the very fixture the attack uses: unmutated, it verifies.
      expect(verifyDsse(env, KA.publicKeyHex).error).toBeNull();

      const original = Buffer.from(env.payload, 'base64');
      const at = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
      expect(at).toBeGreaterThan(-1);

      // F0 9F 98 is a truncated 4-byte sequence: same byte length, and the decoder emits
      // exactly one U+FFFD for it, which is the character EF BF BD encodes. Same byte
      // length matters because the PAE prefix commits to body.length.
      const mutated = Buffer.from(original);
      mutated[at] = 0xf0; mutated[at + 1] = 0x9f; mutated[at + 2] = 0x98;

      // The two halves of the premise, asserted rather than assumed: the bytes really
      // differ, and they really do collide as text. If a future runtime changes decoder
      // behaviour these fail loudly instead of the test quietly passing for free.
      expect(Buffer.compare(original, mutated)).not.toBe(0);
      expect(new TextDecoder().decode(mutated)).toBe(new TextDecoder().decode(original));

      const forged = { ...env, payload: mutated.toString('base64') };
      expect(verifyDsse(forged, KA.publicKeyHex).error?.code).toBe('signature_invalid');
    });

    it('signing bytes did not change signatures over well-formed payloads', () => {
      // Pinned from before the PAE moved to raw bytes. Everything exportDsse produces is
      // well-formed UTF-8, where decode-then-encode was the identity, so the signature
      // must be byte-identical. A different value here means certificates issued by the
      // previous build stopped verifying, which the fix has no business doing.
      //
      // This constant moves if and only if `WARRANT_PREDICATE_TYPE` moves: the predicate type
      // is inside the signed payload, so the signature over that payload necessarily moves
      // with it.
      //
      // This test earns its keep by distinguishing "the signing path broke" from "the signed
      // document legitimately changed", so the distinction is recorded here rather than left
      // as an unexplained constant. Once a real certificate exists, changing this value
      // invalidates it: **treat a failure here as a signing regression until proven
      // otherwise, and do not update it to make the suite green.**
      expect(exportDsse(mkChain(), KA).signatures[0].sig).toBe(
        '805f4a8cfeb2df7104a5ed9cd7a8a9a88eca6277ab97edbbec1a01077bf50abc' +
        'ecbcf943dc7c82f3767155251798ad3f25d074b21fde523246c3f299a3452401',
      );
    });
  });

  describe('the envelope must be the document it says it is', () => {
    it('rejects a validly-signed envelope declaring a different payloadType', () => {
      // env.payloadType is TypeScript-pinned but arrives from JSON.parse at runtime, so the
      // literal type constrains nothing here. Signed under its own declared type, so the
      // signature is genuine and the rejection can only come from the header check.
      const env = signObjectAs(buildStatement(mkChain()), 'text/plain', KA);
      expect(verifyDsse(env, KA.publicKeyHex).error?.code).toBe('signature_invalid');
    });

    it('rejects a validly-signed statement carrying a second subject element', () => {
      // The end-to-end form of the intoto subject finding: proven through the real verify
      // path rather than only against parseStatement, because that is what a third party runs.
      const chain = mkChain();
      const forged = {
        ...buildStatement(chain),
        subject: [
          { name: 'warrant-ledger-chain', digest: { sha256: chain.at(-1)!.hash } },
          { name: 'warrant-ledger-chain', digest: { sha256: 'deadbeef'.repeat(8) } },
        ],
      };
      expect(verifyDsse(signObject(forged, KA), KA.publicKeyHex).error?.code).toBe('signature_invalid');
    });

    it('the honest envelope for the same chain still verifies', () => {
      const chain = mkChain();
      const r = verifyDsse(exportDsse(chain, KA), KA.publicKeyHex);
      expect(r.error).toBeNull();
      expect(r.data).toEqual(chain);
    });
  });

  describe('garbage inputs never throw', () => {
    it('payload is not valid base64', () => {
      const env: DsseEnvelope = { payloadType: PAYLOAD_TYPE, payload: '%%%not-base64%%%',
        signatures: [{ keyid: KA.publicKeyHex, sig: 'ab'.repeat(64) }] };
      const r = verifyDsse(env, KA.publicKeyHex);
      expect(r.error).not.toBeNull();
    });

    it('base64 decodes but is not JSON (validly signed)', () => {
      const env = signRawBody('this is not json', KA);
      const r = verifyDsse(env, KA.publicKeyHex);
      expect(r.error?.code).toBe('signature_invalid');
    });

    it('JSON is not an object: null', () => {
      const env = signRawBody('null', KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('JSON is not an object: array', () => {
      const env = signRawBody('[1,2,3]', KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('JSON is not an object: string', () => {
      const env = signRawBody('"hello"', KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('subject missing', () => {
      const chain = mkChain();
      const env = signObject({
        _type: IN_TOTO_STATEMENT_TYPE, predicateType: WARRANT_PREDICATE_TYPE,
        predicate: { entries: chain },
      }, KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('subject is not an array', () => {
      const chain = mkChain();
      const env = signObject({
        _type: IN_TOTO_STATEMENT_TYPE, subject: { name: 'x' },
        predicateType: WARRANT_PREDICATE_TYPE, predicate: { entries: chain },
      }, KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('predicate.entries missing', () => {
      const env = signObject({
        _type: IN_TOTO_STATEMENT_TYPE,
        subject: [{ name: 'warrant-ledger-chain', digest: { sha256: GENESIS_PREV_HASH } }],
        predicateType: WARRANT_PREDICATE_TYPE, predicate: {},
      }, KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });

    it('predicate.entries is not an array', () => {
      const env = signObject({
        _type: IN_TOTO_STATEMENT_TYPE,
        subject: [{ name: 'warrant-ledger-chain', digest: { sha256: GENESIS_PREV_HASH } }],
        predicateType: WARRANT_PREDICATE_TYPE, predicate: { entries: 'not-an-array' },
      }, KA);
      expect(verifyDsse(env, KA.publicKeyHex).error).not.toBeNull();
    });
  });
});

// Panel finding, pre-publication review: intoto.ts pins subject to exactly one element so
// unbound assertions cannot ride inside a signed document; the identical rule was missing
// one field over. Only signatures[0] is ever read, so extra entries would be carried unread.
describe('DSSE signatures array is pinned to exactly one entry', () => {
  it('an envelope with a second signature is refused, even when the first is valid', () => {
    const entries = mkChain();
    const env = exportDsse(entries, KA);
    const doubled = { ...env, signatures: [env.signatures[0], env.signatures[0]] };
    const r = verifyDsse(doubled as never, KA.publicKeyHex);
    expect(r.error?.code).toBe('signature_invalid');
  });
});
