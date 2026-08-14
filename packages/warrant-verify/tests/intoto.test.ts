import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import { buildStatement, IN_TOTO_STATEMENT_TYPE, parseStatement, WARRANT_PREDICATE_TYPE } from '../src/intoto.js';

const P = { kind: 'agent' as const, id: 'a' };

function mkChain(): LedgerEntry[] {
  const b1 = { seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r',
    at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P, payload: { x: 1 } };
  const h1 = entryHash(b1);
  const b2 = { seq: 2, prevHash: h1, runId: 'r',
    at: '2026-07-16T00:01:00Z', event: 'warrant.issued' as const, principal: P, payload: { x: 2 } };
  return [{ ...b1, hash: h1 }, { ...b2, hash: entryHash(b2) }];
}

describe('buildStatement', () => {
  it('wraps entries with the right _type, predicateType, subject', () => {
    const chain = mkChain();
    const s = buildStatement(chain);
    expect(s._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(s.predicateType).toBe(WARRANT_PREDICATE_TYPE);
    expect(s.subject).toEqual([{ name: 'warrant-ledger-chain', digest: { sha256: chain.at(-1)!.hash } }]);
    expect(s.predicate.entries).toEqual(chain);
  });

  it('empty entries: subject digest is GENESIS_PREV_HASH', () => {
    const s = buildStatement([]);
    expect(s.subject[0]!.digest.sha256).toBe(GENESIS_PREV_HASH);
    expect(s.predicate.entries).toEqual([]);
  });
});

describe('parseStatement', () => {
  it('round trips a statement built by buildStatement', () => {
    const chain = mkChain();
    const r = parseStatement(buildStatement(chain));
    expect(r.error).toBeNull();
    expect(r.data).toEqual(chain);
  });

  it('rejects a wrong _type', () => {
    const chain = mkChain();
    const bad = { ...buildStatement(chain), _type: 'https://example.com/Other/v1' };
    const r = parseStatement(bad);
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.code).toBe('signature_invalid');
  });

  it('rejects a wrong predicateType', () => {
    const chain = mkChain();
    const bad = { ...buildStatement(chain), predicateType: 'https://example.com/Other/v1' };
    expect(parseStatement(bad).error?.code).toBe('signature_invalid');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2, 3]],
    ['a string', 'hello'],
    ['a number', 42],
    ['a boolean', true],
  ])('rejects a statement that is %s, without throwing', (_label, value) => {
    expect(() => parseStatement(value)).not.toThrow();
    expect(parseStatement(value).error).not.toBeNull();
  });

  it('rejects subject missing', () => {
    const { subject, ...rest } = buildStatement(mkChain());
    expect(parseStatement(rest).error).not.toBeNull();
  });

  it('rejects subject that is not an array', () => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, subject: { name: 'x' } }).error).not.toBeNull();
  });

  it('rejects subject that is an empty array', () => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, subject: [] }).error).not.toBeNull();
  });

  it('rejects predicate missing', () => {
    const { predicate, ...rest } = buildStatement(mkChain());
    expect(parseStatement(rest).error).not.toBeNull();
  });

  it('rejects predicate that is not a plain object', () => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, predicate: [1, 2] }).error).not.toBeNull();
  });

  it('rejects predicate.entries missing', () => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, predicate: {} }).error).not.toBeNull();
  });

  it('rejects predicate.entries that is not an array', () => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, predicate: { entries: 'nope' } }).error).not.toBeNull();
  });
});

// The subject is the whole point of an in-toto Statement: it names WHAT the predicate is
// about. buildStatement sets subject[0].digest.sha256 to the chain head hash, but
// parseStatement used to read the subject only to check it was a non-empty array, so the
// digest and the entries in the same document were never compared. A signature says who
// signed; it does not say the signer's document was coherent. An in-toto consumer that
// keys off subject[0].digest (the standard consumption pattern) would then be told the
// certificate covers chain X while the payload it verified carries chain Y.
describe('parseStatement binds the subject digest to predicate.entries', () => {
  function otherChain(): LedgerEntry[] {
    const b = { seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'other',
      at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P, payload: { y: 9 } };
    return [{ ...b, hash: entryHash(b) }];
  }

  it('accepts a statement whose subject digest is its own chain head', () => {
    // The positive case. A digest check that rejected everything would satisfy every
    // negative assertion below and still be useless.
    const chain = mkChain();
    const r = parseStatement(buildStatement(chain));
    expect(r.error).toBeNull();
    expect(r.data).toEqual(chain);
  });

  it('accepts empty entries whose subject digest is GENESIS_PREV_HASH', () => {
    const r = parseStatement(buildStatement([]));
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
  });

  it('rejects a subject digest naming a different chain than the payload carries', () => {
    // The certificate advertises the head of chain A and delivers chain B.
    const a = mkChain();
    const b = otherChain();
    expect(a.at(-1)!.hash).not.toBe(b.at(-1)!.hash);
    const forged = { ...buildStatement(a), predicate: { entries: b } };
    const r = parseStatement(forged);
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.code).toBe('signature_invalid');
  });

  it('rejects a subject digest that is a well-formed but wrong sha256', () => {
    const s = buildStatement(mkChain());
    const bad = { ...s, subject: [{ name: 'warrant-ledger-chain', digest: { sha256: 'ab'.repeat(32) } }] };
    expect(parseStatement(bad).error?.code).toBe('signature_invalid');
  });

  it('rejects empty entries carrying a non-genesis digest', () => {
    const s = buildStatement([]);
    const bad = { ...s, subject: [{ name: 'warrant-ledger-chain', digest: { sha256: mkChain().at(-1)!.hash } }] };
    expect(parseStatement(bad).error?.code).toBe('signature_invalid');
  });

  it.each([
    ['digest missing', { name: 'warrant-ledger-chain' }],
    ['digest not an object', { name: 'warrant-ledger-chain', digest: 'deadbeef' }],
    ['digest null', { name: 'warrant-ledger-chain', digest: null }],
    ['sha256 missing', { name: 'warrant-ledger-chain', digest: {} }],
    ['sha256 not a string', { name: 'warrant-ledger-chain', digest: { sha256: 42 } }],
    ['subject[0] not an object', 'warrant-ledger-chain'],
    ['subject[0] null', null],
  ])('rejects subject[0] with %s', (_label, subject0) => {
    const s = buildStatement(mkChain());
    expect(parseStatement({ ...s, subject: [subject0] }).error?.code).toBe('signature_invalid');
  });

  it('says WHY a non-string sha256 is rejected, instead of blaming the digest comparison', () => {
    // The typeof check does not change the verdict, so the row above passes with or
    // without it: a number fails the digest compare one line down regardless, and a
    // mutation sweep walked straight through. The message IS the guard's contribution.
    // An operator handed "does not match the predicate.entries chain head" for a
    // subject carrying the number 42 goes looking for a chain mismatch that is not
    // there.
    const s = buildStatement(mkChain());
    const r = parseStatement({ ...s, subject: [{ name: 'warrant-ledger-chain', digest: { sha256: 42 } }] });
    expect(r.error?.message).toMatch(/sha256 missing or not a string/);
  });

  // Found by an adversarial review of the first version of this binding: it bound
  // subject[0] and left every later element unread, so the hole moved one array index to
  // the right. The reviewer minted a validly-signed certificate carrying the real chain in
  // predicate.entries and a DIFFERENT chain head in subject[1], and the shipped bin printed
  // "DSSE valid, chain verified" and exited 0. Same root cause for extra digest algorithms
  // and extra subject fields: anything unread inside a signed document is an assertion
  // nothing checked.
  describe('the subject set carries exactly one bound assertion and nothing else', () => {
    const s0 = (sha256: string) => ({ name: 'warrant-ledger-chain', digest: { sha256 } });

    it('rejects a second subject element naming a different chain', () => {
      const chain = mkChain();
      const other = 'deadbeef'.repeat(8);
      expect(other).not.toBe(chain.at(-1)!.hash);
      const forged = { ...buildStatement(chain), subject: [s0(chain.at(-1)!.hash), s0(other)] };
      expect(parseStatement(forged).error?.code).toBe('signature_invalid');
    });

    it('rejects a second subject element even when it names a different artifact entirely', () => {
      // in-toto matches subjects by digest regardless of name, so a plausible-looking name
      // is not a defence and must not be treated as one.
      const chain = mkChain();
      const forged = { ...buildStatement(chain), subject: [
        s0(chain.at(-1)!.hash),
        { name: 'ghcr.io/acme/payments-api', digest: { sha256: 'ab'.repeat(32) } },
      ] };
      expect(parseStatement(forged).error?.code).toBe('signature_invalid');
    });

    it('rejects a subject array padded with copies of the honest element', () => {
      const chain = mkChain();
      const honest = s0(chain.at(-1)!.hash);
      const forged = { ...buildStatement(chain), subject: Array.from({ length: 21 }, () => honest) };
      expect(parseStatement(forged).error?.code).toBe('signature_invalid');
    });

    it.each([
      ['an extra digest algorithm', { name: 'warrant-ledger-chain', digest: { sha256: '', sha512: 'ff'.repeat(64) } }],
      ['an extra digest key', { name: 'warrant-ledger-chain', digest: { sha256: '', gitCommit: 'abc123' } }],
      ['an extra subject field', { name: 'warrant-ledger-chain', digest: { sha256: '' }, uri: 'pkg:oci/payments-api' }],
    ])('rejects subject[0] carrying %s', (_label, shape) => {
      const chain = mkChain();
      const head = chain.at(-1)!.hash;
      // Fill in the real head so the ONLY thing wrong is the extra key: otherwise this
      // would pass on the digest mismatch and prove nothing about the shape rules.
      const s = JSON.parse(JSON.stringify(shape)) as Record<string, { sha256: string }>;
      s.digest!.sha256 = head;
      expect(parseStatement({ ...buildStatement(chain), subject: [s] }).error?.code)
        .toBe('signature_invalid');
    });

    it('accepts the exact C9 shape, so the strictness is not blanket', () => {
      const chain = mkChain();
      const exact = { ...buildStatement(chain), subject: [s0(chain.at(-1)!.hash)] };
      const r = parseStatement(exact);
      expect(r.error).toBeNull();
      expect(r.data).toEqual(chain);
    });
  });

  it('rejects a subject naming something other than the ledger chain', () => {
    // C9 locks subject[0].name. A statement about a different artifact is not this
    // certificate, however validly it was signed.
    const chain = mkChain();
    const bad = { ...buildStatement(chain),
      subject: [{ name: 'some-other-artifact', digest: { sha256: chain.at(-1)!.hash } }] };
    expect(parseStatement(bad).error?.code).toBe('signature_invalid');
  });

  it.each([
    ['no hash field', { seq: 1 }],
    ['a non-string hash', { seq: 1, hash: 42 }],
    ['an empty hash', { seq: 1, hash: '' }],
    ['a non-object entry', 'not-an-entry'],
    ['a null entry', null],
  ])('rejects entries whose last element has %s, and says why', (_label, last) => {
    // The digest cannot be bound to entries that do not state their own head. Rejection
    // here is redundant with the comparison below it (a string is never equal to null),
    // so a mutation sweep that deleted the branch left this test green until it asserted
    // the message. What the branch actually buys is a verifier that tells the operator
    // the entry list is malformed rather than blaming a digest mismatch, and that is
    // what is pinned.
    const s = buildStatement(mkChain());
    const r = parseStatement({ ...s, predicate: { entries: [last] } });
    expect(r.error?.code).toBe('signature_invalid');
    expect(r.error?.message).toMatch(/no usable hash/);
  });
});
