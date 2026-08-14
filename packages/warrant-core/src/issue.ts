import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { canonicalJson } from './canonical.js';
import { paramsHash } from './hash.js';
import { signHex, verifyHex } from './keys.js';
import type { KeyPair } from './keys.js';
import { WarrantSchema } from './types.js';
import type { ActionRequest, Verdict, Warrant } from './types.js';
import type { WarrantError } from './errors.js';

export interface IssueDeps {
  keys: KeyPair;
  now: () => Date;      // injected, no Date.now() in domain logic
  newId: () => string;  // injected, no randomUUID() in domain logic
}

export function issueWarrant(
  input: { request: ActionRequest; verdict: Verdict; reviewRef?: string; ttlMs: number },
  deps: IssueDeps,
): Result<Warrant, WarrantError> {
  if (input.verdict.path === 'deny') {
    return err({ type: 'validation', code: 'cannot_issue_on_deny',
      message: 'Cannot issue a warrant on a deny verdict' });
  }
  try {
    const issuedAt = deps.now();
    const expiresAt = new Date(issuedAt.getTime() + input.ttlMs);
    const id = deps.newId();    // first call → warrant.id
    const nonce = deps.newId(); // second call → warrant.nonce (distinct)
    const unsigned = {
      id,
      runId: input.request.runId,
      principal: input.request.principal,
      action: {
        kind: input.request.action.kind,
        target: input.request.action.target,
        paramsHash: paramsHash(input.request.action.params), // throws if params non-canonical
      },
      policyVersion: input.verdict.policyVersion,
      policyHash: input.verdict.policyHash,
      verdictPath: input.verdict.path as 'auto' | 'human',
      ...(input.reviewRef !== undefined ? { reviewRef: input.reviewRef } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce,
    };
    const signature = signHex(canonicalJson(unsigned), deps.keys.privateKeyHex);
    return ok(WarrantSchema.parse({ ...unsigned, signature }));
  } catch (e) {
    return err({ type: 'validation', code: 'noncanonical_params',
      message: e instanceof Error ? e.message : 'issueWarrant: non-canonical params' });
  }
}

export function verifyWarrant(
  w: Warrant,
  publicKeyHex: string,
  at: Date,
): Result<true, WarrantError> {
  try {
    // Parse first: Zod strips unknown keys so canonicalJson only sees schema fields.
    // Destructure unsigned from the PARSED result, not from raw w, so any attacker-added
    // non-plain-object fields are gone before canonicalJson runs.
    const parsed = WarrantSchema.parse(w);
    // An unparseable timestamp must be malformed, never a pass: NaN compares false
    // against every date, so `new Date('garbage') <= at` would make a garbage expiry
    // immortal. The issuer cannot mint one, but this function takes warrants from anywhere.
    const expiresAt = new Date(parsed.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(new Date(parsed.issuedAt).getTime())) {
      return err({ type: 'validation', code: 'malformed_warrant',
        message: 'issuedAt or expiresAt is not a parseable timestamp' });
    }
    if (expiresAt <= at) {
      return err({ type: 'validation', code: 'warrant_expired',
        message: `Expired at ${parsed.expiresAt}` });
    }
    const { signature, ...unsigned } = parsed;
    if (!verifyHex(signature, canonicalJson(unsigned), publicKeyHex)) {
      return err({ type: 'integrity', code: 'invalid_signature', message: 'Signature mismatch' });
    }
    return ok(true);
  } catch {
    return err({ type: 'validation', code: 'malformed_warrant',
      message: 'verifyWarrant: input could not be parsed or canonicalized' });
  }
}
