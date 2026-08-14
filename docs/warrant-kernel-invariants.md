# Warrant Kernel: Verified Facts and Invariants

> **Summary.** Code-derived reference for the warrant kernel: the core types, the ledger event
> vocabulary, the locked evaluation order, and six invariants that must not be "improved."
> Derived across `warrant-core`, `-policy`, `-ledger`, `-verify`, `-gatewerk`, `-pack-gtm`;
> re-verified against `warrant-policy/src/evaluate.ts` and `warrant-ledger/src/entry.ts`.
>
> **This file makes no claims about scope, roadmap, positioning, or extraction timing.** For the north
> star, see [`00-architecture-v1-and-positioning.md`](strategy/warrant/00-architecture-v1-and-positioning.md).
> Boundary and stack-wide decisions live in the workspace's own docs (private).

## Verified types

| Type | Shape |
|---|---|
| `Principal` | `{kind: agent \| human \| external, id}` |
| `ActionRequest` | `{id, runId, principal, action{kind, target, params}, context}` |
| `Verdict` | `{path: auto \| human \| deny, ruleId, policyVersion, policyHash, reason}` |
| `Warrant` | `{…, action{kind, target, paramsHash}, verdictPath, reviewRef, issuedAt, expiresAt, nonce, signature}` |
| `PolicyDoc` | `{version, defaults:{path:'deny'}, stakes[], protectedAudiences[], caps}` |
| `LedgerEntry` | `{seq, runId, at, event, principal, payload, prevHash, hash}` |

**Ledger events (11):** `warrant.requested` · `policy.evaluated` · `review.submitted` ·
`review.decided` · `warrant.issued` · `warrant.denied` · `warrant.voided` · `action.executed` ·
`action.outcome` · `operator.attested` · `trajectory.attested` (the one OPTIONAL event; contract
in `docs/contracts/trajectory-attested.md`). Defined in the `LedgerEventType` type in
`warrant-ledger/src/entry.ts`; the count is the enum's, not a hand-carried number.

**Evaluation order is LOCKED** (`warrant-policy/src/evaluate.ts`): protected audiences → daily caps →
first matching stake → default deny. Fail-closed at every step.

## Invariants: do NOT change these

1. **`evaluate()` stays a pure function of `(request, policy)`.** No I/O, no clock, no history lookup.
   Purity is what makes verdicts replayable (`warrant-verify/src/replay.ts`), and replay is what gives
   the certificate its value. A feature that seems to need history enters through `request.context`,
   not through the engine. That seam already exists: caps read `context['sentTodayByKind']`.
2. **Deny-by-default at every level.** `defaults.path` is the literal `'deny'`. Unmatched requests
   deny. Malformed input denies rather than throwing.
3. **Deny can never mint a token.** `Warrant.verdictPath` is `'auto' | 'human'` only. Do not widen it.
4. **Nonce single-spend is enforced twice.** An in-transaction check for the clean `nonce_spent`
   error, plus a unique partial index as backstop. Keep both; the redundancy is deliberate.
5. **The ledger is append-and-verify-only.** `readAll()` is a verification primitive feeding the
   hash-chain walk, not a query API. Do not add analytics query methods to the `Ledger` interface.
   Both implementations share `tests/conformance.ts`; any interface change obliges both.
6. **The advisory lock on `append` stays.** It serializes the chain, which hash-chaining requires. It
   is a single-writer ceiling by design, and it is why sweeps need batch records rather than
   per-entity rows.

## The one guard rule

Every path to a side effect must run: `verifyWarrant` → schema parse → recompute `paramsHash` over the
parsed result → compare against `warrant.action.paramsHash` → append `action.executed` (spends the
nonce) → only then perform the effect. This is the GhostApproval defence, and it lives in
`warrant-guard`: `verifyAuthorizedParams` is the shared verify/hash/compare core and
`guardedExecute` the spend-then-act sequence. Executors such as
`warrant-pack-gtm/src/executor.ts` (`executeEmailQueue`) call it and hold no hashing logic of
their own. Any executor that skips it is an ungoverned side-effect path.

## How to verify nothing broke

- `warrant-policy/tests/evaluate.property.test.ts`: property tests on evaluation
- `warrant-ledger/tests/conformance.ts`: shared suite, run by both ledger implementations
- `warrant-ledger/tests/tamper.test.ts`, `security.test.ts`: chain integrity
- `warrant-verify/tests/replay.test.ts`: **the canary. If this breaks, policy purity broke.**
