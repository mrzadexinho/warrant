import type { Result } from '@idriszade/core';
import { err, ok } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';

// C9: wraps the ledger chain in a real in-toto v1 Statement so the DSSE payload matches the
// published "in-toto-interop attestation format" claim (design spec 9.1). The subject digest is
// the chain HEAD hash (last entry's hash, or GENESIS_PREV_HASH when empty): each entry hash
// covers its predecessor, so the head commits to the whole chain transitively. That is why the
// subject attests the evidence itself rather than a derived summary.

export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1' as const;

// A predicate type is a namespace identifier, and it must live somewhere the issuer controls.
// `https://warrant.dev` is not that: Warrant (YC S21) was an authorization company acquired by
// WorkOS in April 2024 and retired into WorkOS FGA. A certificate carrying that string would assert
// its predicate's meaning under a third party's namespace, in a product whose claim is that it
// verifies without trusting anyone.
//
// A GitHub URL rather than a purchased domain: it is controlled, stable, resolvable, and does not
// make a signed artifact depend on a DNS registration staying renewed.
export const WARRANT_PREDICATE_TYPE = 'https://github.com/idriszade/warrant/LedgerChain/v1' as const;
export const SUBJECT_NAME = 'warrant-ledger-chain' as const;

export interface WarrantStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: [{ name: typeof SUBJECT_NAME; digest: { sha256: string } }];
  predicateType: typeof WARRANT_PREDICATE_TYPE;
  predicate: { entries: LedgerEntry[] };
}

/**
 * The chain head hash the subject digest must carry for a given entry list, or null when
 * the list is too malformed to state one. Deliberately shared by buildStatement and
 * parseStatement: if the two derived the digest independently they could drift, and a
 * binding check that reproduces the builder's bug is not a binding check.
 */
function chainHeadDigest(entries: readonly unknown[]): string | null {
  if (entries.length === 0) return GENESIS_PREV_HASH;
  const last = entries[entries.length - 1];
  if (typeof last !== 'object' || last === null || Array.isArray(last)) return null;
  const hash = (last as Record<string, unknown>).hash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

export function buildStatement(entries: LedgerEntry[]): WarrantStatement {
  // The `??` is unreachable for a well-typed LedgerEntry[] (hash is a required string);
  // it exists so this stays total for untyped callers rather than emitting `undefined`.
  const sha256 = chainHeadDigest(entries) ?? GENESIS_PREV_HASH;
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: SUBJECT_NAME, digest: { sha256 } }],
    predicateType: WARRANT_PREDICATE_TYPE,
    predicate: { entries },
  };
}

function invalid(message: string): Result<LedgerEntry[], WarrantError> {
  return err({ type: 'integrity', code: 'signature_invalid', message });
}

/**
 * Exactly these keys, no more. Same reasoning as the one-element subject rule: an extra
 * digest algorithm or an extra subject field is another assertion riding inside the signed
 * document that nothing checks. C9 pins this statement's shape exactly, so a producer that
 * legitimately needs to add a field has to version the predicate type rather than smuggle
 * it past a verifier that shrugs at unknown keys.
 */
function hasExactKeys(o: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(o);
  return keys.length === expected.length && expected.every((k) => Object.hasOwn(o, k));
}

/**
 * Parses a decoded DSSE payload back into the ledger entries it certifies.
 * Never throws: a valid signature over the wrong document (wrong _type, wrong predicateType,
 * or a structurally malformed statement) is not a valid certificate, so every rejection uses
 * the same signature_invalid code as an actual signature mismatch.
 */
export function parseStatement(v: unknown): Result<LedgerEntry[], WarrantError> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return invalid('statement is not a plain object');
  }
  const obj = v as Record<string, unknown>;
  if (obj._type !== IN_TOTO_STATEMENT_TYPE) {
    return invalid('unexpected statement _type');
  }
  if (obj.predicateType !== WARRANT_PREDICATE_TYPE) {
    return invalid('unexpected predicateType');
  }
  // EXACTLY one, not merely at least one. An adversarial review of the first version of
  // this binding found the hole one array index to the right: subject[0] was bound and
  // subject[1..n] were never read. Per in-toto, each subject element is an equally
  // authoritative statement of what the predicate applies to, and artifacts are matched by
  // digest regardless of name, so a second element is a second assertion that this signed
  // predicate covers some other chain. Reaching it needs the signing key, which is why the
  // severity is low rather than high, but an unbound assertion inside a document this
  // verifier calls valid is the exact thing the subject binding exists to prevent.
  if (!Array.isArray(obj.subject) || obj.subject.length !== 1) {
    return invalid('subject must be an array of exactly one element');
  }
  const predicate = obj.predicate;
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    return invalid('predicate missing or not a plain object');
  }
  const entries = (predicate as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    return invalid('predicate.entries missing or not an array');
  }

  // Bind the subject to the payload. Without this the two halves of the statement are
  // independent: the signature covers both, so a coherent signer produces a coherent
  // document, but nothing here checked that the signer WAS coherent. An in-toto consumer
  // reads subject[0].digest to learn which artifact the predicate describes, so an
  // unchecked digest lets a certificate advertise one chain and deliver another.
  const subject0 = obj.subject[0];
  if (typeof subject0 !== 'object' || subject0 === null || Array.isArray(subject0)) {
    return invalid('subject[0] is not a plain object');
  }
  const s0 = subject0 as Record<string, unknown>;
  if (!hasExactKeys(s0, ['name', 'digest'])) {
    return invalid('subject[0] must carry exactly name and digest');
  }
  if (s0.name !== SUBJECT_NAME) {
    return invalid('subject[0].name is not the ledger chain');
  }
  const digest = s0.digest;
  if (typeof digest !== 'object' || digest === null || Array.isArray(digest)) {
    return invalid('subject[0].digest missing or not a plain object');
  }
  if (!hasExactKeys(digest as Record<string, unknown>, ['sha256'])) {
    return invalid('subject[0].digest must carry exactly sha256');
  }
  const sha256 = (digest as Record<string, unknown>).sha256;
  if (typeof sha256 !== 'string') {
    return invalid('subject[0].digest.sha256 missing or not a string');
  }
  const expected = chainHeadDigest(entries);
  if (expected === null) {
    // Refuse rather than skip: an entry list that cannot state its own head is a list the
    // subject cannot be bound to, and skipping the comparison is how the hole existed.
    return invalid('predicate.entries last element carries no usable hash');
  }
  if (sha256 !== expected) {
    return invalid('subject[0].digest.sha256 does not match the predicate.entries chain head');
  }
  return ok(entries as LedgerEntry[]);
}
