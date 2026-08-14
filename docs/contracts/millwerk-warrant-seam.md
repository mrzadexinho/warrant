# Contract: the Millwerk ↔ Warrant seam

**Status:** Owner: Warrant. Consumer: Millwerk.
**Resolves:** Millwerk's Phase 1 handoff questions. Read this instead of a chat transcript.

**Specified vs traversed.** A section marked *specified* means Warrant wrote the shape down. A
section marked **traversed** means a consumer has actually run it end to end, which is a stronger
claim and the only one worth trusting.

| § | Subject | State |
|---|---|---|
| 1 | `inputsRoot` in `request.context`, `contextHash`, the trajectory binding | **traversed**: Millwerk emits `trajectory.attested`, and its certificate test replays with `violations: []` |
| 2 | `Result` from `@idriszade/core` | **traversed**: Millwerk pins `"@idriszade/core": "0.1.0"` exact; no local duplicate remains |
| 3 | The execution seam, `guardedExecute` | **traversed**: `millwerk/src/adapters/actuator/guarded.ts` calls it exactly once and reimplements none of it |
| 4 | Millwerk's three type-level decisions | **confirmed**: a review, not a seam anything traverses |
| 5 | The authorization seam, `requestAuthority` | **traversed**: called from Millwerk's Phase 2 exit test, and nowhere in its `src/` |

## 1. `inputsRoot` lives in `request.context`: accepted

Millwerk proposed putting the trajectory root in `context` because `context` is already
`Record<string, unknown>` and `evaluate()` reads `sentTodayByKind` the same way.

**Accepted, but for a better reason than "no schema change."** It makes a real governance rule
expressible: **deny if `inputsRoot` is absent**, meaning no action without attested provenance. That
rule cannot be written if the root only lives in a ledger event policy never sees.

Accepted shapes, unchanged from Millwerk's Phase 1:

```ts
// toActionRequest(proposal, ctx)
{ id: requestId, runId, principal,
  action: { kind, target, params },
  context: { entityId, inputsRoot } }
```

`toTrajectoryAttestedPayload(proposal)` emits the payload in
[`trajectory-attested.md`](trajectory-attested.md) exactly.

### Two things Warrant owes in return

The question exposed a pre-existing hole. `policy.evaluated`'s payload is
`{requestId, ruleId, path}` and does **not** record the context, so any verdict depending on context
is not re-derivable from the ledger alone. **That is already true of daily caps.** Putting a second
input in context widens it, so:

1. **`policy.evaluated` gains `contextHash`**, a SHA-256 over `canonicalJson(context)`. Closes a hole
   that predates this seam.
2. **`warrant-verify` asserts `context.inputsRoot === trajectory.inputsRoot`** for the same
   `requestId`. With that check the root appearing in two places is not duplication, it is a
   **binding**: the trajectory cannot be swapped without changing what policy saw.

**Both landed.** ✅

`contextHash` is emitted by `warrant-eve/src/approval.ts` and **checked** by `warrant-verify`, which
recomputes `sha256Hex(canonicalJson(warrant.requested.context))` and compares. Emitting a hash nobody
verifies would be a dashboard, not a proof, so the check is the deliverable and the field is the
mechanism. It surfaces on each journey as `contextBinding`:

| `contextBinding` | Meaning |
|---|---|
| absent | `warrant.requested` recorded no context: nothing to bind, nothing claimed |
| `bound` | the hash reproduces |
| `unbound` | context recorded, no `contextHash` (a pre-binding ledger). Rendered as **NO**, never omitted |
| `mismatch` | + a `context_hash_mismatch` violation, and the CLI exits 1 |

A context that cannot be canonicalised fails **closed** as `mismatch`: it cannot have produced the hash
a conforming producer wrote. On the emit side a noncanonical context denies as `context_noncanonical`
rather than as a generic `approval_internal_error`.

The `inputsRoot` binding became four checks rather than one, documented in
[`trajectory-attested.md`](trajectory-attested.md), including `trajectory_missing`, which was not
specified here and is the one that makes *"deny if `inputsRoot` is absent"* mean anything.

**Nothing Millwerk needs from Warrant on this seam is outstanding.** Millwerk may now emit
`trajectory.attested`; the fold is in place, so a certificate will no longer quietly omit it.

## 2. `Result`: install it, do not copy it

Millwerk duplicated `Result` from `@idriszade/core` because it did not resolve, and declared it with
the reason: a `Result` union is a shape with no behaviour, so drift surfaces as a compile error at the
type seam, unlike `canonicalJson` where drift is silent and catastrophic.

**The principle is right and worth keeping as a rule.** The duplication is unnecessary:
`@idriszade/core` is published and warrant resolves it at exactly **0.1.0**.

```
pnpm add @idriszade/core@0.1.0     # pinned exact
```

npm's `latest` is **0.6.3**, five minors ahead of what warrant pins, so do not let a caret drag
Millwerk forward. Collapse the local `Result` to an import once it installs.

## 3. `Actuator.execute`: the guard's real shape

Millwerk flagged its `Actuator.execute(warrant, params, ctx)` as provisional and deliberately did not
reimplement the `paramsHash` recomputation. Correct call. The extraction resolves to:

**Built as `@idriszade/warrant-guard`.** ✅ The real signature, which differs from the
sketch below in three ways, each for a reason worth keeping:

```ts
guardedExecute<T, R>(
  warrant: Warrant,
  rawParams: unknown,
  schema: ZodType<T>,
  deps: { publicKeyHex: string; ledger: Ledger; now: () => Date; outcomeStatus: string },
  effect: (params: T) => Promise<Result<R, WarrantError>>,
): Promise<Result<R, WarrantError>>
```

1. **`principal` is gone from `deps`.** The warrant already binds one, and replay correlates on
   it. Two sources for *who acted* is a hole, so the guard appends under `warrant.principal`
   and accepts no other.
2. **Generic in `R`, not `void`.** An actuator's effect usually produces something its caller
   wants back. `Result<void, …>` would force every actuator to discard its own result and find
   another channel for it.
3. **`outcomeStatus` added.** The vendor's word for success, e.g. `'queued'`, `'sent'`, `'opened'`.
   A per-actuator constant, which is what `deps` is for. The guard supplies `'failed'` itself,
   because failure is not a vendor concept.

The sketch below of the order was right and is unchanged.

Order inside: `verifyWarrant` → parse → `paramsHash(parsed)` → compare against
`warrant.action.paramsHash` → append `action.executed` (spends the nonce) → run `effect` → append
`action.outcome`.

**The actuator owns its schema and its effect closure. Warrant owns everything between them.** So
`serve-email-resend` calls `guardedExecute(warrant, rawParams, EmailParamsSchema, deps, p =>
sendViaResend(p))` and holds no hashing logic at all.

**The nonce is spent before the effect runs.** If the send fails the nonce is burned and the warrant
cannot be retried. Fail-closed on purpose: a burned nonce with no send is strictly safer than a
reusable warrant retried into a double-send. The failure is recorded in `action.outcome`, appended on
both the success and the failure path, so a burned nonce is never left unexplained.

### What Millwerk's `Actuator` should do

`Actuator.execute` must **not** reimplement any of this. Import the guard and supply the two things
that are genuinely the actuator's:

```ts
import { guardedExecute } from '@idriszade/warrant-guard';

// inside an Actuator implementation
return guardedExecute(warrant, rawParams, MyParamsSchema, deps, async (params) => {
  // the effect, and nothing else. No hashing, no nonce, no ledger writes.
});
```

Millwerk needs a second `file:` dependency for it, alongside `warrant-core`:
`"@idriszade/warrant-guard": "file:../warrant/packages/warrant-guard"`.

Vendor-blindness is **enforced**, not requested: the guard's dependency set is pinned exactly and a
test fails on any vendor, transport or domain word appearing anywhere in its source, comments
included. So an actuator that finds the guard awkward must fix the actuator or change the contract
here; it cannot special-case itself into the guard.

**Traversed.** ✅ `millwerk/src/adapters/actuator/guarded.ts` calls `guardedExecute`
exactly once and holds no hashing, nonce or ledger logic; Millwerk's suite is green with zero skips.
This section is no longer a specification waiting for a consumer.

### `verifyAuthorizedParams`: the shared core, which you do not call

`@idriszade/warrant-guard` also exports `verifyAuthorizedParams(warrant, finalParams, deps)`. It is
the security core of the sequence (`verifyWarrant` → optional `runId` check → recompute
`paramsHash` → compare), factored out because **three** paths to a side effect run it, not one:
`guardedExecute`, `warrant-eve`'s `execute`, and the outbox drainer. Their surrounding shapes differ
legitimately (one returns a `Result` and spends a nonce, one throws and its authority was already
spent, one records a refusal outcome), so the pipelines stay distinct while the part that decides
*whether the presented bytes are the bytes somebody authorized* stays single.

**An actuator author does not call it.** `guardedExecute` already does. It is documented here only
so that a future Millwerk session reaching for "I need to check a warrant against some params"
finds the existing primitive instead of writing a fourth copy of the compare.

## 4. Millwerk's three type-level decisions: all confirmed

- **`SignalEvent = FirstSight | Change`, `from: null` only on `FirstSight`.** Same invariant enforced
  at the schema and at the type. Cold start cannot masquerade as a change at either end.
- **`Score` has no reject variant.** A qualifier that wants an entity ignored returns a low score with
  a rationale. This turns the register's *"Millwerk must never deny for policy reasons"* from a rule
  someone has to remember into one the compiler enforces. Best decision in the batch.
- **Every port result extends `Attestable` (`{kind, ref, valueHash}`).** The trajectory design falling
  out as a base interface rather than a step bolted on at the end is the tell that the abstraction
  landed.

## 5. `requestAuthority`: the authorization seam

§3 is the seam where an action *executes*. This is the seam where it becomes *permitted*. They are
two halves of one certificate: `warrant-authorize` proves policy was consulted, `warrant-guard`
proves the thing executed is the thing policy saw.

This sequence existed exactly once, welded to Eve's `ApprovalContext` inside
`warrant-eve/src/approval.ts`. Millwerk is a second real consumer and is not an Eve tool, and a second
real consumer is the threshold for extracting a shared capability into its own package rather than
duplicating it, so it was extracted to **`@idriszade/warrant-authorize`**. Copying it
instead would have been a second source of truth for whether policy was ever consulted: the same
class of mistake as a second guard.

```ts
// packages/warrant-authorize/src/request-authority.ts: copied, not retyped
export interface AuthorizeDeps {
  policy: { doc: PolicyDoc; hash: string };
  keys: KeyPair;
  ledger: Ledger;
  now: () => Date;
  newId: () => string;
  autoTtlMs: number;
}

export type AuthorizeOutcome =
  | { path: 'auto'; verdict: Verdict; warrant: Warrant }
  | { path: 'human'; verdict: Verdict }
  | { path: 'deny'; verdict: Verdict };

export async function requestAuthority(
  request: ActionRequest,
  deps: AuthorizeDeps,
): Promise<Result<AuthorizeOutcome, WarrantError>>
```

Millwerk needs a third `file:` dependency for it:
`"@idriszade/warrant-authorize": "file:../warrant/packages/warrant-authorize"`.

### What it writes, in order

| # | Step | Event appended |
|---|---|---|
| 0 | `contextHash = sha256Hex(canonicalJson(request.context))` | none; computed **before** any append |
| 1 | Record what was asked for | `warrant.requested`: `{requestId, actionKind, target, context}` |
| 2 | `evaluate(request, policy)`, then record it with the hash of the context it saw | `policy.evaluated`: `{requestId, ruleId, path, contextHash}` |
| 3a | verdict `deny` | `warrant.denied`: `{requestId, reason: 'policy_denied:' + ruleId}` |
| 3b | verdict `auto`: `issueWarrant`, then record | `warrant.issued`: `{requestId, warrantId, warrant}` |
| 3c | verdict `human` | **nothing further**: returns the verdict and stops |

Step 0 is before step 1 deliberately. A context that cannot be canonicalised would otherwise die
inside `entryHash`, which canonicalises the whole payload, and surface as a generic internal error
rather than under its own name.

**`deny` is an `ok`, not an `err`.** A refusal is a *successful* authorization decision: the
sequence ran and the ledger records that it ran. Only a failure to *perform* the sequence is an
`err`. A caller that treats `deny` as an error will report ledger outages and policy refusals
identically, which is exactly the diagnosis loss this seam exists to prevent.

### What the caller still owes

Two events. Neither is written here, and forgetting either produces a certificate that looks fine.

1. **`trajectory.attested`: appended by the proposer BEFORE calling `requestAuthority`.**
   `warrant-verify` enforces `seq(trajectory.attested) < seq(warrant.requested)` and raises
   **`trajectory_out_of_order`** otherwise: *an attestation made once authority was already
   requested is a claim, not evidence.* Ordering is the caller's responsibility, because
   `requestAuthority` writes `warrant.requested` as its first act and cannot retroactively make
   room in front of it. Payload shape: [`trajectory-attested.md`](trajectory-attested.md).
2. **`review.submitted`, on the human path only**, after the caller submits the review to a Gate.

### Why it stops before the Gate

Submitting a review needs review **content**, and content is domain-shaped. The boundary register puts
human decision content in Gatewerk. Pulling a `Gate` into this primitive would drag review presentation
into a function whose entire claim is that it knows nothing about the runtime calling it, and the first
consumer with an awkward content shape would start bending it.

> **The boundary does not rest on any one runtime's content shape.** `requestAuthority` stops at the
> verdict because review content *belongs to Gatewerk*, not because it happens to look like an email.
> The `Gate` port's content is opaque (`ReviewContent = Record<string, unknown>`, the `ReviewContent`
> type in `warrant-gatewerk/src/types.ts`), so no binding is obliged to produce any particular shape.
> See [`gate.md`](gate.md) §8.

So the split is: **`requestAuthority` owns the proof spine of authorization; the caller submits the
review and appends `review.submitted`.** The ledger is complete either way at the handover:
`warrant.requested` and `policy.evaluated` are already written when the caller takes over.

Runtime-blindness is **enforced**, not requested, exactly as §3's vendor-blindness is: the
dependency set is pinned to four packages, `@idriszade/warrant-gatewerk` and `eve` are asserted
absent from *every* dependency field, and a word-boundary scan fails on `eve`, `callId`,
`toolInput`, `session` or `ApprovalContext` appearing anywhere in its source, comments included.

### Error codes a caller must map

`requestAuthority` **never throws.** A caller may be an approval callback in an agent runtime,
where a rejected promise is a fail-open: the runtime sees a broken adapter rather than a refusal,
and what happens next is the runtime's guess. Every exit is a value, including an unexpected throw.

| Code | Meaning | Caller's move |
|---|---|---|
| `context_noncanonical` | `canonicalJson(request.context)` threw. Nothing was appended. | Fix the context the proposer built |
| `ledger_error` | An append failed. The message names which event. | Transient: the ledger, not the request |
| `issue_failed` | `issueWarrant` refused, e.g. a key that cannot sign or params that cannot hash | Configuration or proposal defect |
| `authorize_internal_error` | Something threw where nothing should. | A bug, here or in an injected dependency |

**Do not collapse these into one.** A ledger outage, an unhashable context and a key that cannot
sign all stop the run, and only one of them is the operator's to fix. `warrant-eve` maps each to a
distinct denial reason for that reason, and Millwerk should too.

### `mintHumanWarrant` is deliberately not this function

`warrant-eve/src/resume-issue.ts` also issues a warrant, and it is **not** a caller of
`requestAuthority` and must not become one. It runs after a human has decided, re-evaluating
content that may have been **edited** since the request, and issues with `path: 'human'` plus a
`reviewRef`. Two things make this primitive the wrong shape for it: it must **not** append
`warrant.requested`, because the request was recorded before the review; and its verdict comes from
a human decision rather than a fresh policy path, with the re-evaluation acting as a security check
on content that changed after the fact. A primitive whose contract begins *"record the request"*
cannot express that. The duplication is deliberate and recorded, not an oversight to be tidied.
