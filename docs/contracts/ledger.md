# Contract: the `Ledger` port

**Status:** read from the code. Owner: Warrant
(`@idriszade/warrant-ledger`).
**Siblings:** [`gate.md`](gate.md) · [`adapter-authors-guide.md`](adapter-authors-guide.md) ·
[`millwerk-warrant-seam.md`](millwerk-warrant-seam.md). The invariants this file elaborates are
[`../warrant-kernel-invariants.md`](../warrant-kernel-invariants.md) 4, 5 and 6. Concept ownership lives
in the workspace's boundary register (private) §2 and wins on conflict.

**What the port is for.** The ledger is the artifact. Everything else in warrant exists to put entries
into it or to check entries already in it. It is *proof*: append-only, hash-chained, decisions only,
which the register distinguishes explicitly from Gatewerk's operational `audit_event` and Millwerk's
disposable outcomes store (§2, *Two audit trails*). **Only warrant makes tamper-evidence claims.**

**Every line number below was read from the file it names.** Where an older doc disagrees, the
disagreement is called out inline.

## 1. The interface: three methods, and that is the whole of it

```ts
// packages/warrant-ledger/src/entry.ts: the Ledger interface
export interface Ledger {
  append(input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>>;
  readRun(runId: string): Promise<Result<LedgerEntry[], WarrantError>>;
  readAll(): Promise<Result<LedgerEntry[], WarrantError>>;
}
```

| Method | Cite | What it is |
|---|---|---|
| `append` | `entry.ts` | the single writer. Computes `seq`, `prevHash` and `hash`; the caller supplies none of them |
| `readRun` | `entry.ts` | every entry for one `runId`, in `seq` order |
| `readAll` | `entry.ts` | the whole chain, in `seq` order. **A verification primitive, not a query API.** §3 |

No `count`, no `findByEvent`, no `since`, no pagination. That absence is invariant 5 and it is load-bearing;
§3 says why.

## 2. The entry, and the chain

```ts
// packages/warrant-ledger/src/entry.ts: LedgerAppendInput, LedgerEntry, and the genesis hash constant
export interface LedgerAppendInput {
  runId: string; at: string; event: LedgerEventType; principal: Principal; payload: unknown;
}
export interface LedgerEntry extends LedgerAppendInput { seq: number; prevHash: string; hash: string; }

export const GENESIS_PREV_HASH = '0'.repeat(64);
```

`payload` is `unknown` on purpose. **The ledger owns no contract shapes**: even `trajectory.attested`,
which has a schema, keeps that schema in `warrant-core` (the comment above `LedgerEventType` in `entry.ts`).

```ts
// packages/warrant-ledger/src/entry.ts: entryHash
export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  const body = canonicalJson({ runId: e.runId, at: e.at, event: e.event, principal: e.principal, payload: e.payload });
  return createHash('sha256').update(`${e.seq}\n${e.prevHash}\n${body}`, 'utf8').digest('hex');
}
```

Three things follow from those four lines and are worth stating separately:

1. **`seq` and `prevHash` are inside the digest**, so an entry cannot be relocated in the chain without
   changing its own hash.
2. **The body goes through `canonicalJson`** (the `canonicalJson` import in `entry.ts`, from
   `@idriszade/warrant-core`). That is why a
   second canonicaliser anywhere in the workspace would invalidate every certificate ever issued, since
   the ledger's identity *is* that function's output. See [`adapter-authors-guide.md`](adapter-authors-guide.md) §6.
3. **The hash is unkeyed.** The file-header comment in `append-only.ts` says this out loud: anyone who can UPDATE or DELETE rows
   can recompute the entire chain and leave it internally consistent, and `verifyChain` would still pass.
   Tamper-evidence holds against someone *without* table write access. It does not hold against the
   database credential itself. **That is what §5 exists for.**

The first entry links from `GENESIS_PREV_HASH` (the constant in `entry.ts`), enforced identically in both
implementations (`MemoryLedger.append`'s and `PostgresLedger.append`'s `prevHash` fallback) and pinned by the conformance suite
(the `first entry links from GENESIS` case in `tests/conformance.ts`).

Two payload accessors back the claim-uniqueness constraints and are exported for that reason only:
`reviewIdOf` and `reviewRefOf` in `entry.ts`. They are kept as distinct field
names deliberately: the comment above `reviewRefOf` in `entry.ts` notes that `warrant-agent-outbound` and a golden-parity test depend
on `reviewRef` never being renamed to `reviewId`.

## 3. Why `readAll()` is a verification primitive, not a query API

Invariant 5 ([`../warrant-kernel-invariants.md`](../warrant-kernel-invariants.md)): **the ledger is
append-and-verify-only. Do not add analytics methods to `Ledger`.**

The reason is not tidiness. `readAll()` exists to feed the hash-chain walk: a verifier reads *every*
entry in `seq` order and recomputes `entryHash` over each one, checking that each `prevHash` equals its
predecessor's `hash`. **A filtered read cannot do that.** Any method that returns a subset returns rows
whose chain position is unverifiable from the result alone, and a verifier that trusts such a result has
stopped verifying and started querying.

Three consequences, each of which has a concrete cost if ignored:

- **A query method is a second reason to read the ledger**, and the second reason always wins on
  performance grounds. Once `findByEvent('warrant.issued')` exists, replay is the slow path nobody runs,
  and the chain stops being walked end to end.
- **Filtering pushes predicate logic into the port**, which means it has to know payload shapes. `payload`
  is `unknown` (the `payload: unknown` field on `LedgerAppendInput` in `entry.ts`) precisely so it does not.
- **Both implementations share one suite** (§6). An interface change obliges both, forever. The interface
  is small because keeping two implementations honest about a large one is not free.

`readRun(runId)` is the one filter, and it is not an exception: `runId` is a top-level column
(the `run_id` filter in `PostgresLedger.readRun`'s query), it is inside the digest (the `runId` field in `entryHash`'s digest body, `entry.ts`), and a run is the unit a certificate is
issued over. It is a partition of the chain, not a query over it.

**Where analytics belongs:** outside. The register routes derived, disposable learning to Millwerk's
outcomes store and operational history to Gatewerk's `audit_event` (§2, *Two audit trails*). A projection
out of the ledger is the legal return path; a query method inside it is not.

## 4. The ledger event vocabulary: eleven events, enumerated from the code

```ts
// packages/warrant-ledger/src/entry.ts: LedgerEventType
export type LedgerEventType =
  | 'warrant.requested' | 'policy.evaluated' | 'review.submitted' | 'review.decided'
  | 'warrant.issued' | 'warrant.denied' | 'warrant.voided'
  | 'action.executed' | 'action.outcome' | 'operator.attested'
  | 'trajectory.attested';
```

| # | Event | Cite | Written by | Note |
|---|---|---|---|---|
| 1 | `warrant.requested` | `entry.ts` | the `warrant.requested` append in `requestAuthority` (`warrant-authorize/src/request-authority.ts`) | first act of the authorization seam; a run holding a verdict and no request cannot be replayed |
| 2 | `policy.evaluated` | `entry.ts` | the `policy.evaluated` append in `requestAuthority` | carries `contextHash` |
| 3 | `review.submitted` | `entry.ts` | the caller, after submitting to a `Gate` (the `review.submitted` append in `buildApproval`, `warrant-eve/src/approval.ts`, after `gate.submit`) | **not** written by `requestAuthority`. See [`adapter-authors-guide.md`](adapter-authors-guide.md) §3 |
| 4 | `review.decided` | `entry.ts` | the caller, on resume (the `review.decided` claim append in `resumeByPoll`, `warrant-eve/src/resume.ts`, step 7) | claimed *before* minting or denying, so the claim is the idempotency key |
| 5 | `warrant.issued` | `entry.ts` | `requestAuthority`'s auto path (`request-authority.ts`); the human path goes through the shared outcome append in `appendTerminalOutcome` (`warrant-eve/src/resume.ts`) | |
| 6 | `warrant.denied` | `entry.ts` | `requestAuthority`'s deny path; human path likewise through `appendTerminalOutcome` (`resume.ts`) | policy payload `reason: 'policy_denied:' + ruleId` (in `requestAuthority`) |
| 7 | `warrant.voided` | `entry.ts` | none | in the vocabulary; **no producer in any `src/` in this repo.** It appears only in the type and in the nonce-scope test in `tests/append-integrity.test.ts` |
| 8 | `action.executed` | `entry.ts` | the `action.executed` append in `guardedExecute` (`warrant-guard/src/guarded-execute.ts`), and in `buildExecute` step 4 (`warrant-eve/src/execute.ts`) | **spends the nonce.** The only event the single-spend machinery keys on |
| 9 | `action.outcome` | `entry.ts` | the `action.outcome` append in `guardedExecute` | appended on **both** the success and the failure path |
| 10 | `operator.attested` | `entry.ts` | the `operator.attested` append in `markSent` (`warrant-pack-gtm/src/attest.ts`) | consumed by replay in the `case 'operator.attested'` branch of `warrant-verify/src/replay.ts`'s event-folding switch |
| 11 | `trajectory.attested` | `entry.ts` | Millwerk's Composer, **before** `warrant.requested` | the one **optional** event and the only one appended by a producer upstream of warrant (the comment above `LedgerEventType` in `entry.ts`). Payload schema: [`trajectory-attested.md`](trajectory-attested.md) |

**`trajectory.attested` required no migration**, and the reason matters for anyone extending the
vocabulary: `warrant_ledger.event` is plain `TEXT` with no `CHECK` constraint (the same comment in `entry.ts`, and the
DDL in `PostgresLedger.ensureTable`, `postgres.ts`). The type is a TypeScript-side guarantee only. A new event costs a type change
and nothing at the database.

> **Contradiction with an existing doc, code wins.**
> [`../warrant-kernel-invariants.md`](../warrant-kernel-invariants.md) says *"Ledger events (10) … Defined
> at `warrant-ledger/src/entry.ts`."* Both halves are stale: there are **eleven**, enumerated in the
> `LedgerEventType` type in `entry.ts`. The eleventh is `trajectory.attested`, added with the Millwerk seam. Nothing about
> the invariants themselves is affected.

## 5. Append, and the two properties that guard it

### Invariant 6: the advisory lock stays

```ts
// packages/warrant-ledger/src/postgres.ts: inside PostgresLedger.append, after acquiring the client
await client.query('BEGIN');
await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
```

`append` reads the chain tail (the chain-tail query in `PostgresLedger.append`), derives `seq = prev + 1` and `prevHash = prev.hash`
(the `seq`/`prevHash` derivation right after it), and inserts. **That is a read-then-write over shared state, and hash-chaining has
no way to merge two concurrent tails.** Without the lock, two appends read the same tail and produce two
entries claiming the same `seq` and the same `prevHash`, one of which is a fork, and both of which hash
correctly. The lock serialises the chain. It is a **single-writer ceiling by design**, and it is why
sweeps need batch records rather than per-entity rows.

`CHAIN_LOCK` is derived once from `sha256('warrant-ledger')` and passed through `BigInt.asIntN(64, …)`
(the `CHAIN_LOCK` derivation in `postgres.ts`), exported as `CHAIN_LOCK_KEY` for a range test. **The `asIntN` is
not cosmetic.** `pg_advisory_xact_lock` takes a *signed* bigint; an unsigned digest exceeds `int8` and
Postgres raises `22003` on every append: a failure a catch mapping it to a generic `db_error` would hide,
leaving `PostgresLedger` silently writing nothing at all, invisible whenever the Postgres tests are
env-gated and skip without a database. A suite run without a database is not evidence.

### Invariant 4: nonce single-spend, enforced twice

| Layer | Cite | Yields |
|---|---|---|
| in-transaction `SELECT` precheck, inside the lock | the nonce precheck in `PostgresLedger.append` | the clean `nonce_spent` error (returned from that precheck) |
| unique partial index `warrant_ledger_nonce_uniq` on `(payload->>'nonce') WHERE event = 'action.executed'` | the `warrant_ledger_nonce_uniq` index DDL in `PostgresLedger.ensureTable` | the backstop, mapped to `nonce_spent` by **constraint name** (in `PostgresLedger.append`'s catch block) |

The comment above the constraint-name mapping in `PostgresLedger.append` explains why the mapping keys on the constraint name and never on SQLSTATE `23505`
alone: a `23505` on any *other* constraint must fall through to `db_error` rather than being
blanket-reported as a spent nonce. `MemoryLedger` reproduces the precheck in-process
(`MemoryLedger.append`'s nonce precheck).

### Claim uniqueness: the concurrent-resume close

Two further partial unique indexes, `warrant_ledger_review_uniq` on `(event, payload->>'reviewId')`
and `warrant_ledger_reviewref_uniq` on `(event, payload->>'reviewRef')`
(both DDL'd in `PostgresLedger.ensureTable`), both mapped to `duplicate_review_claim` in the same catch block. `MemoryLedger`
closes the same TOCTOU with a check-then-push and **no intervening `await`** (the claim-uniqueness check in `MemoryLedger.append`,
reasoning in the comment above it), ordered after the nonce check so a nonce collision always wins.
The comment above those two indexes in `ensureTable` notes the deliberate consequence: Postgres never restricts NULLs in a unique index,
so the auto path's `warrant.issued`, which carries neither field, is completely unconstrained.

### Two more things `append` refuses

- **A caller-supplied `seq` or `prevHash`.** `const base = { ...input, seq, prevHash }` spreads `input`
  **first** in both implementations (`MemoryLedger.append` and `PostgresLedger.append`'s `base` construction). The comment above `PostgresLedger.append`'s `base` construction records why
  it matters more there: the INSERT writes the *computed* columns while `entryHash` was taken over `base`,
  so spreading input last persisted a row whose hash did not match its own columns and left the chain
  unverifiable from that row onward.
- **A non-plain payload.** `entryHash` calls `canonicalJson`, which throws; both wrap it and return
  `noncanonical_payload` (the `entryHash` try/catch in `MemoryLedger.append` and `PostgresLedger.append`) rather than propagating. Deny-by-default,
  invariant 2: malformed denies rather than throwing.

### Error codes on `append`

| Code | Type | Cite |
|---|---|---|
| `nonce_spent` | `integrity` | `MemoryLedger.append`'s nonce precheck; `PostgresLedger.append`'s precheck and constraint-name mapping |
| `duplicate_review_claim` | `integrity` | `MemoryLedger.append`'s two claim checks; `PostgresLedger.append`'s constraint-name mapping |
| `noncanonical_payload` | `integrity` | `MemoryLedger.append` and `PostgresLedger.append`'s `entryHash` catch |
| `db_error` | `transient` | `PostgresLedger.append`, `.readRun`, and `.readAll`'s catch blocks (Postgres only) |

## 6. Two implementations, one suite

| | `MemoryLedger` | `PostgresLedger` |
|---|---|---|
| Cite | `packages/warrant-ledger/src/memory.ts` (the `MemoryLedger` class) | `packages/warrant-ledger/src/postgres.ts` (the `PostgresLedger` class) |
| State | a private array (the `_entries` field) | the `warrant_ledger` table (the `CREATE TABLE` DDL in `ensureTable`) |
| Serialisation | JS single-threadedness, no `await` between check and push (the check-then-push comment in `MemoryLedger.append`) | `pg_advisory_xact_lock` (in `PostgresLedger.append`) |
| Reads | `structuredClone` on the way out, so a caller cannot mutate internal state (in `MemoryLedger.append`, `.readRun`, and `.readAll`) | fresh rows via `rowToEntry` |
| Extra | `fromEntries`: rebuilds and **re-verifies** a chain, rejecting non-contiguous `seq`, a broken `prevHash`, or a bad hash (`MemoryLedger.fromEntries`) | `ensureTable`: idempotent DDL plus the three indexes |

`MemoryLedger.fromEntries`' contiguity check (the `seq === i + 1` check inside it) is the deletion-forgery close: a gap in
`seq` means an entry was removed, and every surviving hash still verifies.

**The conformance suite pins them to each other.** `runLedgerConformance(name, makeLedger)` lives at
`packages/warrant-ledger/tests/conformance.ts`, holds 14 shared cases, and is run twice:
`tests/conformance-memory.test.ts` and `tests/conformance-postgres.test.ts`. It is exported from the test
file and **deliberately not from `src/index.ts`**: the comment above the ledger exports in `src/index.ts` says so explicitly: *vitest test
code must not enter the production surface.*

`conformance-postgres.test.ts` is `describe.skipIf(!DB_URL)` on `WARRANT_TEST_DATABASE_URL`, and gives its
file a private schema (`wl_conformance`) because vitest runs files in parallel workers and two Postgres
test files sharing one table could never both pass. **Any change to the `Ledger` interface obliges both
implementations**: that is the operative half of invariant 5, and the suite is what makes it true rather
than aspirational.

## 7. Append-only, in SQL: the two-role privilege split

The hash chain proves tampering **to someone who cannot rewrite rows**. This section is what makes the
application credential one of those people.

Three functions, three distinct jobs. Confusing them is the failure mode.

| Function | Cite | Job | Runs as |
|---|---|---|---|
| `applyAppendOnlyGuards` | `append-only.ts` | **installs** the property | the table **owner** |
| `assertLedgerAppendOnly` | `assert-append-only.ts` | **proves** the property | whatever role the pool authenticated as |
| `provisionLedger` | `provision.ts` | runs both, then re-proves through the app's own credential | both, deliberately |

### `applyAppendOnlyGuards`: install

`appendOnlySql` in `append-only.ts` is the pure part: it returns the ordered statement list and touches
no connection, clock or environment. Eight statements (the ordered list `appendOnlySql` returns):

1. `CREATE OR REPLACE FUNCTION {table}_append_only()`: raises `42501` naming `TG_OP`
2-3. drop and create `{table}_append_only_row`, `BEFORE UPDATE OR DELETE … FOR EACH ROW`
4-5. drop and create `{table}_append_only_truncate`, `BEFORE TRUNCATE … FOR EACH STATEMENT`.
   The comment above that statement in `append-only.ts` notes a row trigger cannot see TRUNCATE at all, and that omitting this
   statement-level trigger is *the gap most deployments leave open*
6. `REVOKE UPDATE, DELETE, TRUNCATE … FROM PUBLIC` (**PUBLIC first**, reasoning in the comment right above it)
7. the same `REVOKE … FROM {role}`
8. `GRANT INSERT, SELECT … TO {role}`

Identifiers are interpolated, not bound, because `GRANT` and `CREATE TRIGGER` accept no parameters, so
`SQL_IDENTIFIER` in `append-only.ts` is the only thing between a caller-supplied name and live SQL, and
it excludes `$` deliberately because the function body is dollar-quoted with `$warrant_ao$`
(per the comment above `SQL_IDENTIFIER`). Length is bounded too (`MAX_TABLE_LEN` and `MAX_ROLE_LEN`): Postgres truncates identifiers at
63 bytes **silently**, and at 51+ characters `{fn}_row` and `{fn}_truncate` collapse to the same name, so
statement 4 would drop the row trigger statement 3 just created and the whole thing would still report ok
(per the comment above those constants). Violations return `invalid_identifier` (`invalidIdentifier`).

`applyAppendOnlyGuards` then runs the list in **one transaction** and **verifies the end state** with
`has_table_privilege` (`VERIFY_SQL`) before returning ok. The doc comment above `applyAppendOnlyGuards`
argues both halves: without the transaction a failure at the REVOKE leaves triggers installed and grants
untouched, indistinguishable from "nothing applied"; without the verification, `ok` means only *"the
statements ran"*, and a role that **inherits** UPDATE from a parent role still holds it after every
statement succeeds. That case returns `append_only_not_enforced` with an actionable message
(the residual-privilege check in `applyAppendOnlyGuards`). Codes: `append_only_apply_failed` (returned when the connection can't be acquired, and in the statement-loop catch), `append_only_unverified`
(returned when no privilege row comes back, and in the outer catch), `append_only_not_enforced` (returned for a residual privilege, and for a missing INSERT/SELECT grant).

**The honest limit, stated in the source** (the file-header honesty comment in `append-only.ts`): neither the trigger nor the REVOKE binds
the table **owner** or a superuser. An owner can `DROP TRIGGER` or `ALTER TABLE … DISABLE TRIGGER`. **The
property is only real when the application role is not the owner of the table.**

### `assertLedgerAppendOnly`: prove, and there is exactly one of it

It is a **catalog read, not a mutation** (the comment above `assertLedgerAppendOnly` explaining it is a catalog read): `has_table_privilege` is
authoritative about inherited and PUBLIC grants (`PRIV_SQL`), `pg_trigger` says whether the
triggers are enabled (`TRIGGER_SQL`), and `pg_class.relowner` answers the question that decides
whether any of it binds.

It returns an `AppendOnlyProof` (table, `currentUser`, `owner`, five
privilege booleans, two trigger booleans) and returns `err` on the **first** property that does not hold,
naming it, because *a partially hardened ledger is not a weaker guarantee, it is no guarantee: an attacker
only needs one of UPDATE, DELETE or TRUNCATE* (per the doc comment above `assertLedgerAppendOnly`).

| Code | Cite | Condition |
|---|---|---|
| `invalid_identifier` | `assert-append-only.ts` | table name is not a plain identifier (`IDENT`) |
| `ledger_table_missing` | `assert-append-only.ts` | no such table |
| `ledger_probe_failed` | `assert-append-only.ts` | the catalog read threw |
| **`ledger_role_owns_table`** | `assert-append-only.ts` | **the load-bearing one.** `currentUser === owner` |
| `ledger_role_cannot_append` | `assert-append-only.ts` | lacks INSERT or SELECT |
| `ledger_role_can_update` / `_can_delete` / `_can_truncate` | `assert-append-only.ts` | a residual privilege survives |
| `ledger_row_trigger_missing` | `assert-append-only.ts` | `{table}_append_only_row` absent or disabled |
| `ledger_truncate_trigger_missing` | `assert-append-only.ts` | `{table}_append_only_truncate` absent or disabled |

Trigger state is read from `tgenabled`, where `'D'` means disabled and `'O'`, `'R'`, `'A'` are all enabled
(the `rowTriggerEnabled`/`truncateTriggerEnabled` computation in `assertLedgerAppendOnly`). The names are derived the same way `appendOnlySql` derives them, and a
drift test asserts both strings appear in the generated SQL (per the comment above that computation): *a probe looking for a trigger
name nobody creates would report "missing" forever, which is fail-closed but useless, and would look
identical to a genuinely unhardened table.*

**It reads privileges for `current_user`, so which pool it is handed is part of the claim**
(per the comment above `assertLedgerAppendOnly` about `current_user` scoping the claim). Run it on the owner connection and it proves nothing about the
application. It deliberately does **not** know which role it is supposed to be looking at; callers that
care must check `proof.currentUser` themselves. `provisionLedger` is the caller that does (§7, next).

> **`assertLedgerAppendOnly` is the one ledger posture check, and a second must never be written.**
> The file-header comment in `assert-append-only.ts` records the reasoning: it has two consumers (the ceremony and
> `provisionLedger`), which is the threshold for extracting a shared capability rather than duplicating
> it. The stronger reason is **placement**: the function that *installs* the property and the
> function that *proves* it belong in the same package, so a change to the trigger names cannot land in one
> without the other being in front of the same reader. `warrant-ledger` cannot import the demo package
> anyway, so the alternative was a second copy, and **a second source of truth for a security control is
> the same mistake as a second guard.**

### `provisionLedger`: three connections, and none of them is an accident

```ts
// packages/warrant-ledger/src/provision.ts: provisionLedger
export async function provisionLedger(
  owner: pg.Pool,
  app: pg.Pool,
  opts: ProvisionOptions,
): Promise<Result<AppendOnlyProof, WarrantError>>
```

`ProvisionOptions` is `{ appRole, table? }`. The sequence:

1. `new PostgresLedger(owner).ensureTable()`: `ensure_table_failed` on throw
2. `applyAppendOnlyGuards(owner, { role: appRole, table })`: errors pass straight through
3. `assertLedgerAppendOnly(app, table)`: **the app pool, not the owner pool**
4. `proof.currentUser !== opts.appRole` → `app_role_mismatch`

Step 4 is the check `assertLedgerAppendOnly` structurally cannot make. The comment above that check in `provision.ts`: everything
above would pass for a credential pointing at any *other* non-owner role, and would then be reported as a
hardened ledger the application does not use.

The file-header comment in `provision.ts` is the argument for the shape, and it answers the obvious objection:
`applyAppendOnlyGuards` already verifies its own end state, so why re-prove? Because *the question this
file has to answer is "can the credential in the application's environment rewrite history", and only a
connection made with that credential can answer it.*

It is **idempotent** (per the doc comment above `provisionLedger`): `CREATE … IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP IF EXISTS`,
`REVOKE`, `GRANT`. Re-running on a hardened ledger with rows in it changes nothing and re-proves the
property. *A step you are afraid to re-run is a step nobody runs after an incident.*

### The operator entrypoint

`pnpm provision:ledger` (the `provision:ledger` script in `package.json`) → `packages/warrant-ledger/src/provision-cli.ts`.
`readProvisionEnv` in `provision-cli.ts` is pure so its refusals are testable with no database, and
collects **every** problem rather than stopping at the first (per its doc comment). It reads
`WARRANT_LEDGER_ADMIN_DATABASE_URL`, `WARRANT_LEDGER_DATABASE_URL`, `WARRANT_LEDGER_APP_ROLE`
and optional `WARRANT_LEDGER_TABLE`, rejects unsubstituted `<placeholders>`
(the placeholder check inside `req`), rejects non-identifier role and table names (the identifier checks), and rejects **the two URLs being
identical** (the identical-URL check), because that silently destroys the prove-through-the-app-credential property and
would surface as a `ledger_role_owns_table` message pointing the reader at the database instead of at
their environment. All of it under `provision_env_invalid`. The CLI prints the proof and
**never the connection strings** (per the file-header comment, output in `main`).

The placeholder check is not defensive noise: a `.env` can go out with `<SUPER>`/`<OWNER>`/`<APP>` still
in it, Postgres initialises with those literal strings as passwords, and **the container comes up
healthy.**

### Where the boundary runs

The register settles it (§2 and *A healthy container is not an append-only ledger*): **the ledger's
schema, its append-only guards, and the proof they hold are warrant's; its container, volumes, roles and
secrets are pursuit's.** The service directory creates roles and schemas and stops. Duplicating this SQL
into a container init script would be a second source of truth for a security control. *The guarantee is
that the app role does not own the table, and a property that lives in SQL cannot be maintained by a
container.*

## 8. What must not be added

- **A query or analytics method on `Ledger`.** Invariant 5; §3 above.
- **A second ledger posture check.** `assertLedgerAppendOnly` is the one.
- **A second `canonicalJson`.** The ledger's identity is that function's output; see
  [`adapter-authors-guide.md`](adapter-authors-guide.md) §6.
- **Anything that removes the advisory lock**, including "just for the memory backend": the conformance
  suite runs the same cases against both, and the property it is pinning is the chain, not the driver.
- **A contract shape in this package.** `payload` is `unknown` (the `payload: unknown` field on `LedgerAppendInput`); even
  `trajectory.attested`'s schema lives in `warrant-core` (the comment above `LedgerEventType` in `entry.ts`).

## 9. How to verify nothing broke

`packages/warrant-ledger/tests/`: `conformance-memory.test.ts` and `conformance-postgres.test.ts` (the
shared suite), `tamper.test.ts` and `security.test.ts` (chain integrity), `postgres-lock.test.ts` (the
`asIntN` range regression), `append-only.test.ts` and `append-only-live.test.ts`, `provision.test.ts`,
`ledger-properties.test.ts`, `index-exports.test.ts`.

**A suite run without `WARRANT_TEST_DATABASE_URL` skips every Postgres case and is not evidence.** The
`asIntN` incident (the comment above `CHAIN_LOCK` in `postgres.ts`) is what that rule was written from.
