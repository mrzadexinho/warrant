# @idriszade/warrant-ledger

Append-only, hash-chained ledger on Postgres (or memory). Append-and-verify only, deliberately
not a query API.

Every decision warrant makes lands here as an entry, and each entry hashes its predecessor. This
package owns writing that chain and proving it holds. It does not own reading it back for
analysis: `readAll` exists so a verifier can replay the chain, not so an application can query it.
See [`docs/contracts/ledger.md`](../../docs/contracts/ledger.md) for the full contract.

## Entry points

`PostgresLedger` and `MemoryLedger` both implement `Ledger`: `append(input)` writes one entry and
returns it (or a typed error), `readAll()` returns every entry for verification.

```ts
import { PostgresLedger } from '@idriszade/warrant-ledger';

const ledger = new PostgresLedger(pool);
const appended = await ledger.append({
  runId, at: new Date().toISOString(), event: 'warrant.requested', principal, payload,
});
if (appended.error) throw new Error(appended.error.message);
```

`provisionLedger(opts)`: creates the table (if missing) and applies the append-only guards
(triggers plus a revoked grant set) against a given app role, then proves the result with
`assertLedgerAppendOnly`.

```ts
import { provisionLedger } from '@idriszade/warrant-ledger';

const proof = await provisionLedger({ adminPool, appPool, appRole: 'warrant_app' });
if (proof.error) throw new Error(proof.error.message);
```

`assertLedgerAppendOnly(pool, table?)`: reads live Postgres privileges and trigger state for the
connected role and returns a typed proof, or the first violated property, naming it. Used both by
provisioning and by a ceremony preflight that refuses to run against a table it does not own.

## What it deliberately does not do

- **No query methods on `Ledger`.** `readAll()` is a verification primitive: it exists for
  `warrant-verify`'s replay, not for building reports or dashboards on top of the ledger. Adding
  analytics methods here is explicitly out of scope.
- **No trust in the table owner.** `assertLedgerAppendOnly` fails outright when the connected role
  owns the table, because an owner can drop the guarding triggers and is not bound by `REVOKE`.
  Append-only is a property of the *role*, not of the schema alone.
- **No silent nonce reuse.** Nonce single-spend is enforced twice: an in-transaction check and a
  unique partial index, on purpose, so one layer failing does not silently open the other.
- **No advisory-lock removal.** `append` serializes the chain through an advisory lock. Removing
  it would let two writers race on the same hash chain.

## Tests

```bash
pnpm --filter "@idriszade/warrant-ledger" test
```

The Postgres-backed suite needs a live database; the memory-backed suite runs the same conformance
tests without one.
