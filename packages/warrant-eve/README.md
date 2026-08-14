# @idriszade/warrant-eve

The adapter that governs **Vercel eve** agents. Wrap a tool, and the agent can no longer perform
that action without a warrant.

This is warrant's first adapter, and the proof that the kernel is runtime-agnostic: policy,
ledger, gate and verifier are untouched by anything in this package. What lives here is only the
translation between eve's tool and approval model and warrant's.

## What it gives you

| Export | What it does |
|---|---|
| `withWarrant(tool, binding, deps)` | Wraps a `PlainTool` into an eve tool whose execution is gated by a warrant. |
| `resumeByPoll(deps, { reviewId, runId, deliver })` | Resumes a parked run once a human decision exists, and reports the outcome. |
| `exportLedgerJson(...)` | Writes the run's ledger out for `warrant-verify`. |
| `MemoryParkStore`, `PostgresParkStore` | Where parked runs wait. One shared conformance suite covers both. |

## How a governed call flows

1. The wrapped tool is called. The request is recorded and the policy evaluated.
2. On `auto`, a warrant is minted and the tool runs.
3. On `human`, a review is submitted and the call **parks**. Nothing has been authorized yet.
4. A decision arrives. The run resumes, the decision is claimed, a warrant is minted, and only
   then does the tool run.
5. On `deny` or a rejection, nothing runs and the denial is recorded.

## Invariants. Do not break these

**The webhook is a doorbell, not a decision.** An inbound webhook only says "go look". The
decision is always re-fetched from the gate. A payload claiming a decision is never trusted, so
forging the webhook buys an attacker nothing.

**The park store holds no authorization data.** It is eve plumbing: where a call was, so it can be
picked up again. The ledger is the sole authority on what was authorized. A compromised park store
cannot authorize anything.

**`review.decided` is claimed before any warrant is minted.** The claim is the idempotency key, on
both the approve and the deny branch, and the ledger enforces uniqueness on it. This is what
closes the concurrent-resume race: two resumes for one review cannot both mint. The loser
re-derives the winner's outcome instead of erroring.

**The human attestation is checked at the boundary, not trusted from the type.** `Gate` is
exported for third parties to implement, so `decidedBy: string` is a compile-time promise a JS
consumer does not keep. A decision arriving without a decider is refused with
`human_attestation_missing` before the claim, so it leaves no trace of having been accepted.
Without that check the failure is silent, because `canonicalJson` drops undefined keys before
hashing and the certificate would attest a human review naming no human.

## Usage

```ts
import { withWarrant, resumeByPoll } from '@idriszade/warrant-eve';

const governed = withWarrant(sendEmailTool, binding, deps);

// later, when a decision has landed
await resumeByPoll(deps, { reviewId, runId, deliver: async (outcome) => { /* ... */ } });
```

## Tests

```bash
pnpm --filter "@idriszade/warrant-eve" test
```

The `PostgresParkStore` half is env-gated and skips without a database. A skipped test here counts
as uncovered:

```bash
WARRANT_TEST_DATABASE_URL="postgresql://$USER@localhost:5432/warrant_ledger_verify" \
  pnpm --filter "@idriszade/warrant-eve" test
```

## State

Milestone A (governed eve agents, adapter plus end-to-end proof) is merged. Milestone B adds the
live Gatewerk gate, the park store, the trigger and webhook channels, and the resume path. The
**live ceremony has not run**, so every proof so far is a local end-to-end run. See `WARRANT.md`
at the repo root.
