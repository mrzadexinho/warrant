// Guards in src/keys.ts, src/issue.ts and src/canonical.ts that a mutation sweep found
// unheld across ALL NINE warrant packages, not just this one.
//
// Measuring per-package would have overstated this list by a quarter: three of the
// twelve survivors here were held by a dependent package's tests. Everything below
// survived the cross-package re-run.
//
// canonicalJson is the foundation the whole product rests on. Every paramsHash, every
// entryHash, every policyHash and every warrant signature is taken over its output, so
// a value it can silently mangle is two different authorizations that hash alike.
//
// The canonical guards are a nest of MUTUALLY SUBSUMING rejections: each value that one
// branch refuses is refused a few lines later by another with a different message, so
// single deletion measures nothing and the sweep reported all of them as survivors. What
// they collectively hold is that canonicalJson REFUSES rather than improvises, and that
// it says which value it refused. The tests below assert the messages for that reason,
// and are caught by the joint deletion of the group.
import { describe, it, expect } from 'vitest';
import { canonicalJson, paramsHash, generateKeyPair, signHex, verifyHex, issueWarrant, verifyWarrant } from '../src/index.js';
import type { ActionRequest, Verdict, Warrant } from '../src/types.js';

const KEYS = generateKeyPair('a'.repeat(64));
const NOW = new Date('2026-07-27T00:00:00.000Z');
const LATER = new Date('2026-07-27T00:00:30.000Z');

const REQUEST: ActionRequest = {
  id: 'req-1', runId: 'run-1', principal: { kind: 'agent', id: 'a' },
  action: { kind: 'send_email', target: 'ok@acme.com', params: { to: 'ok@acme.com' } },
  context: {},
};
const VERDICT: Verdict = {
  path: 'auto', ruleId: 'known', policyVersion: '0.1.0', policyHash: 'f'.repeat(64), reason: 'auto',
};

function mkWarrant(): Warrant {
  let n = 0;
  const r = issueWarrant(
    { request: REQUEST, verdict: VERDICT, ttlMs: 60_000 },
    { keys: KEYS, now: () => NOW, newId: () => `id-${++n}` },
  );
  if (r.error) throw new Error(`fixture issue failed: ${r.error.message}`);
  return r.data;
}

describe('canonicalJson refuses values it cannot represent, and says which', () => {
  it.each([
    ['top-level undefined', undefined, /undefined is not allowed/],
    ['undefined inside an array', { a: [1, undefined, 2] }, /undefined element in array/],
    ['a Symbol value', { a: Symbol('s') }, /Symbol is not allowed/],
    ['a function value', { a: () => 1 }, /function is not allowed/],
  ])('%s is rejected with a [canonical] message', (_label, value, pattern) => {
    // Each of these is caught a few lines further down by a broader branch too, so the
    // verdict never changes; what changes is whether the error names the value. A hash
    // function that throws "non-plain object: [object Symbol]" for a Symbol sends the
    // caller looking at the wrong thing.
    expect(() => canonicalJson(value)).toThrow(/\[canonical\]/);
    expect(() => canonicalJson(value)).toThrow(pattern);
  });

  it('an object reachable by two paths is not mistaken for a cycle', () => {
    // `ancestors.delete(obj)` on the way out is what makes the cycle check a check on
    // ANCESTORS rather than on everything already seen. Without it a shared sub-object
    // is rejected as circular, so a perfectly ordinary params shape becomes unhashable
    // and every warrant over it fails to issue.
    const shared = { to: 'ok@acme.com' };
    const dag = { primary: shared, cc: shared };

    expect(() => canonicalJson(dag)).not.toThrow();
    expect(canonicalJson(dag)).toBe('{"cc":{"to":"ok@acme.com"},"primary":{"to":"ok@acme.com"}}');
  });

  it('a genuine cycle is still rejected', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular reference/);
  });

  it('two params that differ only in key order hash identically, and differing params do not', () => {
    // The positive control for the whole file: a canonicaliser hardened into refusing
    // everything satisfies every rejection test above.
    expect(paramsHash({ a: 1, b: 2 })).toBe(paramsHash({ b: 2, a: 1 }));
    expect(paramsHash({ a: 1, b: 2 })).not.toBe(paramsHash({ a: 1, b: 3 }));
  });
});

describe('signHex encodes the message as UTF-8', () => {
  it('a non-ASCII message round-trips', () => {
    // signHex and verifyHex must agree on the encoding, and every warrant whose target
    // or params carry a non-ASCII character depends on it. A latin1 encoder produces a
    // different byte string for anything above U+00FF, so signing would still "work"
    // and verification would fail on exactly the warrants that carry a name with an
    // accent in it. Nothing in the repo signed a non-ASCII string.
    const message = 'Grüße an Zoë 東京 🎉';
    const sig = signHex(message, KEYS.privateKeyHex);

    expect(verifyHex(sig, message, KEYS.publicKeyHex)).toBe(true);
    // And it is genuinely bound to those bytes: a different string does not verify.
    expect(verifyHex(sig, 'Grusse an Zoe', KEYS.publicKeyHex)).toBe(false);
  });

  it('a warrant whose target is non-ASCII issues and verifies', () => {
    // The end-to-end form, through the real issue/verify path rather than the helpers.
    let n = 0;
    const request: ActionRequest = {
      ...REQUEST,
      action: { kind: 'send_email', target: 'zoë@acmé.example', params: { subject: '東京より' } },
    };
    const issued = issueWarrant(
      { request, verdict: VERDICT, ttlMs: 60_000 },
      { keys: KEYS, now: () => NOW, newId: () => `id-${++n}` },
    );

    expect(issued.error).toBeNull();
    expect(verifyWarrant(issued.data!, KEYS.publicKeyHex, LATER).error).toBeNull();
  });
});

describe('a verified warrant carries no unsigned passengers', () => {
  // An extra key must never ride inside a document `verifyWarrant` calls valid: schemas that
  // strip unknown keys before canonicalising would leave an injected key neither signed nor
  // read nor refused. `warrant-pack-gtm`'s executor copies `warrant.principal` RAW into a
  // ledger append that `entryHash` covers and `exportDsse` signs, so an unread passenger could
  // reach the certificate.
  //
  // Same call `intoto.ts`'s `hasExactKeys` makes one document over: an extra field is another
  // assertion riding inside a signed document that nothing checks.
  it('an unknown top-level key makes the warrant malformed, not valid', () => {
    const w = mkWarrant();
    const withExtra = { ...w, smuggled: 'attacker-controlled' } as unknown as Warrant;

    const r = verifyWarrant(withExtra, KEYS.publicKeyHex, LATER);
    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('an unknown key on the nested principal is refused too', () => {
    // Top-level strictness alone would leave this open, and the principal is the
    // sub-object warrant-pack-gtm's executor copies verbatim into the ledger.
    const w = mkWarrant();
    const withExtra = {
      ...w, principal: { ...w.principal, smuggled: 'attacker-controlled' },
    } as unknown as Warrant;

    const r = verifyWarrant(withExtra, KEYS.publicKeyHex, LATER);
    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('an unknown key inside action is refused too', () => {
    const w = mkWarrant();
    const withExtra = {
      ...w, action: { ...w.action, smuggled: 'attacker-controlled' },
    } as unknown as Warrant;

    const r = verifyWarrant(withExtra, KEYS.publicKeyHex, LATER);
    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('an untouched warrant still verifies, so strict is not rejecting everything', () => {
    const w = mkWarrant();
    expect(verifyWarrant(w, KEYS.publicKeyHex, LATER).error).toBeNull();
  });

  it('issueWarrant refuses a principal it cannot sign faithfully, rather than returning a warrant that can never verify', () => {
    // The asymmetry this closes: issue.ts put the RAW principal into `unsigned` and
    // signed that, then returned WarrantSchema.parse(...), which STRIPPED the extra key.
    // The signature therefore covered a principal the returned warrant did not carry, so
    // a request whose principal had one stray key produced an ok() warrant that could
    // never verify anywhere. Measured before this change: issue succeeded and
    // verifyWarrant returned invalid_signature. Failing closed at issue time is the
    // honest outcome.
    const request: ActionRequest = {
      id: 'req-x', runId: 'run-x',
      principal: { kind: 'agent', id: 'a', smuggled: 'passenger' },
      action: { kind: 'send_email', target: 'ok@acme.com', params: { to: 'ok@acme.com' } },
      context: {},
    } as unknown as ActionRequest;
    let n = 0;
    const issued = issueWarrant(
      { request, verdict: VERDICT, ttlMs: 60_000 },
      { keys: KEYS, now: () => NOW, newId: () => `id-${++n}` },
    );

    expect(issued.error).not.toBeNull();
    expect(issued.data).toBeNull();
  });

  it('a structurally malformed warrant is malformed_warrant, not invalid_signature', () => {
    // Without the parse, a warrant missing a required field reaches canonicalJson and
    // comes back as a signature mismatch. Both reject, so only the code distinguishes
    // them, and the code is what tells an operator whether they are looking at a
    // tampered certificate or a corrupted one.
    const w = mkWarrant();
    const { nonce: _nonce, ...missingField } = w;

    const r = verifyWarrant(missingField as unknown as Warrant, KEYS.publicKeyHex, LATER);

    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('a request whose target is not a string is refused rather than signed', () => {
    // The parse on the ISSUE side, and the only reachable way to see it: everything
    // else in `unsigned` is built from literals, so a well-formed call produces a
    // schema-shaped object with or without the parse. A non-string target is not
    // hypothetical, evaluate() guards against exactly it, and issueWarrant is an
    // exported function any caller can reach.
    //
    // Without the parse this SIGNS: canonicalJson is perfectly happy with a number, so
    // a validly-signed warrant goes out whose action.target is 123. Every downstream
    // check then passes, because they all compare against the signed field.
    let n = 0;
    const r = issueWarrant(
      {
        request: { ...REQUEST, action: { ...REQUEST.action, target: 123 as unknown as string } },
        verdict: VERDICT, ttlMs: 60_000,
      },
      { keys: KEYS, now: () => NOW, newId: () => `id-${++n}` },
    );

    expect(r.error).not.toBeNull();
    expect(r.data).toBeNull();
  });

  it('issueWarrant returns a schema-validated warrant, so a bad build fails at the source', () => {
    // Its contribution is that a warrant which does not satisfy the schema can never be
    // signed and handed out: the failure surfaces where the warrant is made rather than
    // at every verifier that later receives it.
    const w = mkWarrant();

    expect(w.id).toBe('id-1');
    // id and nonce are distinct newId() calls; a warrant whose nonce equals its id
    // would make the spend-once record collide with the warrant identity.
    expect(w.nonce).toBe('id-2');
    expect(w.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(w.action.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(w).sort()).toEqual([
      'action', 'expiresAt', 'id', 'issuedAt', 'nonce', 'policyHash', 'policyVersion',
      'principal', 'runId', 'signature', 'verdictPath',
    ]);
  });
});
