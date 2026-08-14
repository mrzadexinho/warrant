# How warrant is tested

A governance layer earns trust through how it fails, so the suite tests failure harder than
success. This page describes the test classes and what each one exists to catch.

## Unit and integration suite

Every package carries its own tests, run in CI against a real Postgres 16 service. The
database-backed tests cover the ledger's append-only guards at the SQL level: the application
role is refused UPDATE, DELETE, and TRUNCATE by grants and triggers, and the tests prove the
refusals fire rather than assuming the configuration holds.

## Property-based fuzzing

Every surface that accepts bytes from a stranger is fuzzed with fast-check: warrant
verification, DSSE envelope verification, chain replay, and the policy document loader. The
properties assert two things under randomized field deletion, arbitrary value replacement,
signature mutation, truncated encodings, and malformed YAML: the surface never throws (every
failure is a typed result), and it never fails open (no mutation of signed or authored content
verifies clean).

## Payload ablation

The dangerous bug class in governance code does not fail loudly; it succeeds wrongly. A missing
value flows through, and something mints anyway. The ablation harness targets exactly that
shape: every key on the authority path is deleted, one at a time, programmatically, and the
harness asserts no ablated variant reaches a minted warrant or an approved decision. Keys are
iterated from the fixtures rather than hand-listed, so a future field is covered automatically.

## Concurrency

Single-spend is proven under real contention, not by reading the code: 50 parallel execution
attempts against one warrant yield exactly one success, 49 clean nonce-spent refusals, one
effect invocation, and one executed entry in the ledger. Separately, 50 parallel appends to one
run produce a gapless, hash-verified chain, on the in-memory ledger and on real Postgres.

## Portability

CI runs on Linux, macOS, and Windows across Node 20, 22, and 24. Every job ends by re-verifying
the production certificate that ships in the tree, so "the proof verifies on your machine" is a
continuously tested claim, not a once-tested one.

## Documentation drift

A script extracts every import from the package READMEs' code examples and checks the named
symbols against the package's real exports, in CI. Documented APIs cannot drift silently from
the code. The error vocabulary is likewise documented in [`error-codes.md`](error-codes.md)
rather than left as folklore.

## What the tests do not claim

The certificate's own documentation
([`../packages/warrant-eve-outbound-demo/ceremony/README.md`](../packages/warrant-eve-outbound-demo/ceremony/README.md))
states the trust limits the suite cannot remove: the signing key is self-asserted, and a hash
chain does not survive an attacker who owns the database table. Testing proves the guarantees
that were designed; it does not add ones that were not.
