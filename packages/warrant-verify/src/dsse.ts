import type { Result } from '@idriszade/core';
import { err } from '@idriszade/core';
import type { KeyPair, WarrantError } from '@idriszade/warrant-core';
import { canonicalJson, signBytes, verifyBytes } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { buildStatement, parseStatement } from './intoto.js';

export interface DsseEnvelope {
  payloadType: 'application/vnd.in-toto+json';
  payload: string; // base64(canonicalJson(WarrantStatement))
  signatures: [{ keyid: string; sig: string }];
}

const PAYLOAD_TYPE = 'application/vnd.in-toto+json' as const;

/**
 * PAE: utf8('DSSEv1 ' + len(type) + ' ' + type + ' ' + len(body) + ' ') then body bytes.
 *
 * Returns BYTES, and they are signed as bytes. This used to end in TextDecoder().decode()
 * and hand the resulting JS string to signHex/verifyHex, which re-encoded it. That round
 * trip is the identity only for well-formed UTF-8. On the verify path `body` is whatever
 * base64 the envelope carried, so it is attacker-chosen: the decoder folds every invalid
 * sequence to U+FFFD, and distinct payloads of the same byte length collapse to one
 * message. A signature then binds the decoded text rather than the payload, which is the
 * opposite of what DSSE's PAE exists to do. Concretely, EF BF BD and F0 9F 98 both decode
 * to a single U+FFFD, so swapping one for the other inside a payload left the signature
 * valid over bytes nobody had signed.
 */
function paeBytes(pt: string, body: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const ptBytes = enc.encode(pt);
  const prefix = enc.encode(`DSSEv1 ${ptBytes.length} ${pt} ${body.length} `);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/**
 * Signs entries as a DSSE envelope. The payload is an in-toto Statement (C9) wrapping the
 * entries, not the bare array: buildStatement is a plain constructor over already-validated
 * LedgerEntry objects, so the throw surface here is canonicalJson itself, same as before C9.
 */
export function exportDsse(entries: LedgerEntry[], keys: KeyPair): DsseEnvelope {
  const body = new TextEncoder().encode(canonicalJson(buildStatement(entries)));
  const sig = signBytes(paeBytes(PAYLOAD_TYPE, body), keys.privateKeyHex);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(body).toString('base64'),
    signatures: [{ keyid: keys.publicKeyHex, sig }],
  };
}

/**
 * Verifies a DSSE envelope's signature, then parses the in-toto Statement inside and returns
 * its predicate.entries. Never throws: any failure, including a malformed base64/JSON payload
 * or a validly-signed statement with the wrong _type/predicateType, returns a typed err.
 */
export function verifyDsse(env: DsseEnvelope, publicKeyHex: string): Result<LedgerEntry[], WarrantError> {
  try {
    // The declared type is TypeScript-pinned to the literal but not runtime-pinned: the CLI
    // does verifyDsse(JSON.parse(readFileSync(...)), key), so this value comes off disk
    // unvalidated. Without the check an envelope declaring payloadType 'text/plain' while
    // carrying an in-toto Statement verified clean and returned its entries. The PAE is
    // length-prefixed on both type and body, so forging this needs the signing key and it is
    // not a cross-protocol confusion; it is the same class as the subject binding, a signed
    // document whose own header disagrees with its contents, and the verifier's job is to
    // refuse to launder that.
    const declaredType: string = env.payloadType;
    if (declaredType !== PAYLOAD_TYPE) {
      return err({ type: 'integrity', code: 'signature_invalid', message: 'unexpected DSSE payloadType' });
    }
    // Exactly one signature, same rule as the subject pin in intoto.ts: only
    // signatures[0] is ever read, so extra entries would ride inside the envelope
    // unverified, and a signed document must not carry assertions nothing checks.
    if (env.signatures.length !== 1) {
      return err({ type: 'integrity', code: 'signature_invalid',
        message: `expected exactly 1 DSSE signature, got ${env.signatures.length}` });
    }
    const body = new Uint8Array(Buffer.from(env.payload, 'base64'));
    const pae = paeBytes(env.payloadType, body);
    if (!verifyBytes(env.signatures[0].sig, pae, publicKeyHex)) {
      return err({ type: 'integrity', code: 'signature_invalid', message: 'DSSE signature invalid' });
    }
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return parseStatement(parsed);
  } catch (e) {
    return err({
      type: 'integrity',
      code: 'signature_invalid',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
