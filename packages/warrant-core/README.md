# @idriszade/warrant-core

The permit, and the primitives everything else in warrant is built on.

A **warrant** is a single-use, expiring, signed object stating that one specific principal may
perform one specific action with one specific set of parameters. It is not a session token and not
a capability that can be reused. Every other warrant package depends on this one.

## What it gives you

| Export | What it does |
|---|---|
| `issueWarrant(input, deps)` | Mints a signed warrant from a request plus a policy verdict. Refuses a `deny` verdict outright. |
| `verifyWarrant(w, publicKeyHex, at)` | Checks structure, expiry and Ed25519 signature. Returns a typed error, never throws. |
| `canonicalJson(value)` | Deterministic serialization. Every hash and signature in warrant is taken over its output. |
| `sha256Hex`, `paramsHash` | Hashing, and the parameter fingerprint bound into each warrant. |
| `generateKeyPair`, `signHex`, `verifyHex`, `signBytes`, `verifyBytes` | Ed25519. |
| `PrincipalSchema`, `ActionRequestSchema`, `VerdictSchema`, `WarrantSchema` | The Zod schemas and their inferred types. |

## What a warrant binds

Every field is covered by the signature:

- **who**: `principal` (`agent`, `human` or `external`, plus an id)
- **what**: `action.kind` and `action.target`
- **exactly what**: `action.paramsHash`, a SHA-256 over the canonicalized parameters, so a warrant
  approved for one email body does not authorize a different one
- **under which rules**: `policyVersion` and `policyHash`
- **how it was authorized**: `verdictPath` (`auto` or `human`) and an optional `reviewRef`
- **once, and not forever**: a `nonce` the ledger spends, and `issuedAt` / `expiresAt`

## Design notes that will bite you if you miss them

**`canonicalJson` refuses rather than improvises.** `undefined`, symbols, functions and undefined
array elements are rejected with a message naming the offending value, instead of being silently
dropped. Silently dropping is how two different authorizations come to hash alike. Object keys are
sorted, so key order never changes a hash.

**The schemas are strict.** Unknown keys are rejected, not stripped, at the top level and on the
nested `principal` and `action`. A warrant carrying an extra key is `malformed_warrant`, not
valid. This is deliberate: the signature covers schema fields only, so a stripping schema would
let an unsigned, unread field ride inside a document the verifier calls valid. The trade is that
adding a warrant field is a lockstep upgrade, because an older verifier refuses a newer warrant
outright rather than ignoring the new field.

**`verifyWarrant` parses before canonicalising**, so hostile input is normalized away before it
reaches the hashing path.

**Everything returns `Result`, nothing throws.** A malformed warrant and a tampered one are
distinguished by error code (`malformed_warrant` versus `invalid_signature`), because that
distinction is what tells an operator whether they are looking at corruption or an attack.

## Usage

```ts
import { generateKeyPair, issueWarrant, verifyWarrant } from '@idriszade/warrant-core';

const keys = generateKeyPair(privateKeyHex);
const issued = issueWarrant(
  { request, verdict, ttlMs: 5 * 60 * 1000 },
  { keys, now: () => new Date(), newId: () => randomUUID() },
);
if (issued.error) return issued;

const ok = verifyWarrant(issued.data, keys.publicKeyHex, new Date());
```

## Tests

```bash
pnpm --filter "@idriszade/warrant-core" test
```

## Limitation

This package sets `main` to TypeScript source, so it loads under tsx or vitest but not plain
`node`. Giving it a real build is a separate ship gate. If you need something a third party can
run without a toolchain, that is `warrant-verify`, whose bin ships as a self-contained bundle.
