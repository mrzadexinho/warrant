# Contributing

Thanks for looking under the hood. Ground rules, so a change lands smoothly:

## Setup

Node 20 or newer, pnpm 10 or newer.

```bash
pnpm install
pnpm typecheck
pnpm test          # DB-gated tests skip unless WARRANT_TEST_DATABASE_URL is set
pnpm demo          # full offline chain; writes packages/warrant-eve-outbound-demo/out/proof.md
```

For the full suite, point `WARRANT_TEST_DATABASE_URL` at any throwaway Postgres 16:

```bash
docker run -d --rm -e POSTGRES_PASSWORD=pw -p 55444:5432 postgres:16
# create a database, then:
WARRANT_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55444/warrant_test pnpm test
```

## The invariants are not up for casual revision

Read [`docs/warrant-kernel-invariants.md`](docs/warrant-kernel-invariants.md) before touching
`warrant-core`, `warrant-policy`, `warrant-ledger`, `warrant-guard`, `warrant-authorize`, or
`warrant-verify`. In particular:

- `evaluate()` stays pure. No I/O, no clock, no history.
- Deny by default. Malformed input denies rather than throws.
- One guard. Every path to a side effect runs the same verify-hash-compare-spend sequence.
- Exactly one `canonicalJson`. A second implementation is a fork of identity itself.
- The ledger is append-and-verify only. It does not grow query methods.

Some things in this codebase look like duplication and are deliberate (the verifier's
independent Merkle fold, for example). If a refactor makes the repo tidier by removing one of
these, the PR needs to engage the written reason, not just the code.

## Practical expectations

- `pnpm typecheck` and `pnpm test` green before a PR.
- New behavior comes with a test that fails without the change.
- Public API changes: update the affected package README and any contract doc in
  `docs/contracts/` that cites the changed symbol.
- Prose style: plain sentences. No em dashes.
