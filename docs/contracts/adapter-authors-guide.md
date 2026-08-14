# Adapter author's guide

**Status:** read from the code. Owner: Warrant. Audience: anyone writing an adapter
against warrant from outside this repo.
**Siblings:** [`gate.md`](gate.md) · [`ledger.md`](ledger.md) · [`millwerk-warrant-seam.md`](millwerk-warrant-seam.md)
(§3 and §5 are the same two seams, described from Millwerk's side). Concept ownership lives in
the workspace's boundary register (private) and wins on conflict.

## 1. Which of the two primitives do I need?

**Warrant has exactly two entry points for an adapter, and they answer different questions.**
`requestAuthority` (`@idriszade/warrant-authorize`) is the **authorization** seam and answers ***was this
permitted***: it records what was asked for, evaluates policy, records the verdict, and on the auto path
hands back a signed warrant. `guardedExecute` (`@idriszade/warrant-guard`) is the **enforcement** seam and
answers ***did what executed stay inside what was permitted***: it takes a warrant and some params,
proves the params are the bytes that warrant binds, spends the nonce, runs your effect, and records the
outcome. **If you are deciding whether an action may happen, you want the first. If you are about to cause
a side effect, you want the second. Most real adapters want both, in that order, and nothing in between
is yours to write.**

| | `requestAuthority` | `guardedExecute` |
|---|---|---|
| Package | `@idriszade/warrant-authorize` | `@idriszade/warrant-guard` |
| Entry point | the `requestAuthority` export in `packages/warrant-authorize/src/index.ts` | the `guardedExecute` export in `packages/warrant-guard/src/index.ts` |
| Question | was this permitted | did what executed stay inside what was permitted |
| Input | an `ActionRequest` you built | a `Warrant` you were issued, plus raw params |
| Writes | `warrant.requested`, `policy.evaluated`, then one of `warrant.denied` / `warrant.issued` | `action.executed`, then `action.outcome` |
| Throws | never (the outer `try/catch` in `requestAuthority`) | never; every exit is a `Result`, including a thrown effect (the `catch` around the `effect` call in `guardedExecute`, producing `effect_threw`) |
| You still owe the ledger | `trajectory.attested` **before**; `review.submitted` on the human path | nothing |

Both are half of one certificate. `warrant-authorize` proves policy was consulted; `warrant-guard` proves
the thing executed is the thing policy saw. The register puts it as *"two seams, and a certificate needs
both."* Skipping either produces a certificate that looks fine and proves less than it appears to.

## 2. `requestAuthority`: the authorization seam

```ts
// packages/warrant-authorize/src/request-authority.ts: requestAuthority
export async function requestAuthority(
  request: ActionRequest,
  deps: AuthorizeDeps,
): Promise<Result<AuthorizeOutcome, WarrantError>>
```

```ts
// packages/warrant-authorize/src/request-authority.ts: AuthorizeDeps
export interface AuthorizeDeps {
  policy: { doc: PolicyDoc; hash: string };
  keys: KeyPair;
  ledger: Ledger;
  now: () => Date;
  newId: () => string;
  autoTtlMs: number;
}

// packages/warrant-authorize/src/request-authority.ts: AuthorizeOutcome
export type AuthorizeOutcome =
  | { path: 'auto'; verdict: Verdict; warrant: Warrant }
  | { path: 'human'; verdict: Verdict }
  | { path: 'deny'; verdict: Verdict };
```

`now` and `newId` are **injected, not read**: the package performs no I/O of its own beyond the ledger you
hand it, and a test asserts there is no clock, no id source and no network in its source
(the `defines no schema and performs no I/O of its own beyond the injected ledger` test in `packages/warrant-authorize/tests/runtime-blind.test.ts`). A non-injected clock or id would break
the replayability the whole artifact rests on.

### What it writes, in order

| # | Step | Event | Where |
|---|---|---|---|
| 0 | `contextHash = sha256Hex(canonicalJson(request.context))` | none | the `contextHash` computation in `requestAuthority`, before Step 1 |
| 1 | record what was asked for: `{requestId, actionKind, target, context}` | `warrant.requested` | Step 1 in `requestAuthority` |
| 2 | `evaluate(request, policy)`, then record it **with the hash of the context it saw**: `{requestId, ruleId, path, contextHash}` | `policy.evaluated` | Step 2 in `requestAuthority` |
| 3a | verdict `deny`: `{requestId, reason: 'policy_denied:' + ruleId}` | `warrant.denied` | Step 3 in `requestAuthority` |
| 3b | verdict `auto`: `issueWarrant`, then `{requestId, warrantId, warrant}` | `warrant.issued` | Step 4 in `requestAuthority` |
| 3c | verdict `human` | **nothing further** | Step 5 in `requestAuthority` |

Step 0 runs before step 1 deliberately (see the comment preceding the `contextHash` computation in `requestAuthority`): `entryHash` canonicalises the whole
payload one step below and would throw on an uncanonicalisable context anyway, surfacing as a generic
internal error rather than under its own name.

**`deny` is an `ok`, not an `err`** (see the doc comment above `AuthorizeOutcome` in `request-authority.ts`). A refusal is a *successful*
authorization decision: the sequence ran and the ledger records that it ran. Only a failure to *perform*
the sequence is an `err`. An adapter that treats `deny` as an error will report ledger outages and policy
refusals identically: exactly the diagnosis loss this seam exists to prevent.

### Error codes you must map, and not collapse

| Code | Type | Where | Meaning | Your move |
|---|---|---|---|---|
| `context_noncanonical` | `validation` | the `context_noncanonical` return in `requestAuthority`'s `contextHash` `try/catch` | `canonicalJson(request.context)` threw. **Nothing was appended** | fix the context your proposer built |
| `ledger_error` | `transient` | the `ledgerError` helper in `request-authority.ts`, called at all four `ledger.append` sites | an append failed; the message names which event | transient: the ledger, not the request |
| `issue_failed` | `validation` | the `issue_failed` return after `issueWarrant`, in `requestAuthority`'s auto-path branch | `issueWarrant` refused (a key that cannot sign, params that cannot hash) | configuration or proposal defect |
| `authorize_internal_error` | `permanent` | the outer `catch` block of `requestAuthority` | something threw where nothing should | a bug, here or in an injected dependency |

**Do not collapse these into one.** A ledger outage, an unhashable context and a key that cannot sign all
stop the run, and only one of them is the operator's to fix.

**That rule binds an adapter's surfaced text, not only its branching, and it binds every path in the
adapter, not only the one you are currently writing.** Getting the branch right and the wording wrong
is the same diagnosis loss under a different name: a reader, on a text-only channel, usually a model
deciding what to tell a person next, sees only the words, and two branches worded the same are
indistinguishable to it even when their internal `path` or error code differs. The trap is treating one
corrected branch as having closed the rule: an adapter with more than one path to the same three
outcomes (denied, outage, guard refusal) has to say so identically on **every** one of them, or the path
you did not touch quietly reintroduces the exact confusion the rule exists to prevent.

`warrant-mcp`'s `governTool` is the worked example, because it has two branches that each have to
report all three outcomes (the auto path and the human path), and both now use the same vocabulary:
`refused by policy: <ruleId>` for the one case that means *you are not permitted*
(the `deny`-verdict branch in `packages/warrant-mcp/src/govern-tool.ts`), `governance unavailable: <code>` for every case where
warrant could not complete its sequence, on either path (the `requestAuthority`-error branch, and the
`submitResult.error` branch's `gate_unreachable` / `gatewerk_api_error` / `gatewerk_missing_review_id` /
default cases, in `govern-tool.ts`), and
`execution refused: <code>: <message>` for a guard-level refusal (the human-path params-hash failure, and the `guardedExecute`-error branch, in `govern-tool.ts`). In
MCP specifically the text *is* the channel: `McpToolResult` carries no structured error, so an outage
worded like a denial produces a confident, false claim that the user lacks permission. Two tests pin
the vocabularies apart on each branch independently and assert the outage words and the denial words
never share a line (the `a policy denial reads as a verdict; an unreachable ledger reads as a fault` test, and the `reports an outage on this path as an outage, not as a denial` test, in `packages/warrant-mcp/tests/govern-tool.test.ts`).

**When the host framework's type cannot express an outage, say so in the field that can, and expect
your adapter to look like it breaks this rule.** `warrant-eve`'s approval path returns eve's
`ApprovalStatus`, whose members are `not-applicable | approved | denied | user-approval`
(the `ApprovalStatus` type exported from eve's public `tools` module). **There is no outage-shaped member**, and
`denied` is the only fail-closed one, so a ledger outage, an unhashable context, an unreachable gate
and a genuine policy refusal all leave `approval.ts` as `type: 'denied'`
(the `context_noncanonical`, `ledger_error`, `gate_unreachable`, and `deny`-verdict returns in `packages/warrant-eve/src/approval.ts`). That is **not** the defect this
section describes, and the difference is worth being precise about: `reason` is a *separate structured
field*, and every one of those sites sets it to a distinct code, so the cases remain
distinguishable to anything that reads it. The MCP case was different precisely because
`McpToolResult` has no structured error at all: the text was the only channel, so the text had to
carry the category.

**The rule that generalises: find the most structured field the host will let you use, and put the
category there.** Where the discriminant is forced flat, the honest fix is not to invent wording that
the type contradicts, but to make the *adjacent* field carry the distinction and to write down that
it is doing so; otherwise the next reader "fixes" it by copying a pattern that does not apply.

## 3. What you still owe the ledger after `requestAuthority` returns

**Two events. Neither is written for you, and forgetting either produces a certificate that looks fine.**

1. **`trajectory.attested`: appended by the proposer BEFORE you call `requestAuthority`.**
   `warrant-verify` enforces `seq(trajectory.attested) < seq(warrant.requested)` and raises
   **`trajectory_out_of_order`** otherwise (the `trajectory_out_of_order` member of `RunViolation['kind']`
   in `packages/warrant-verify/src/types.ts`, raised at the `trajectory_out_of_order` violation push in
   `replayRun`, `packages/warrant-verify/src/replay.ts`). *An attestation made once authority was already requested
   is a claim, not evidence.* The ordering is yours because `requestAuthority` writes `warrant.requested`
   as its first act (the `warrant.requested` append, Step 1, in `requestAuthority`) and cannot retroactively make room in front of it.
   Payload shape: [`trajectory-attested.md`](trajectory-attested.md).
   Related verifier violations you will meet if you get this wrong: `trajectory_missing`
   (the `trajectory_missing` member of `RunViolation['kind']` in `warrant-verify/src/types.ts`, raised at the
   `trajectory_missing` violation push in `replay.ts`) and `context_hash_mismatch`
   (the `context_hash_mismatch` member of `RunViolation['kind']` in `warrant-verify/src/types.ts`, raised at
   the `context_hash_mismatch` violation push in `replay.ts`'s context-binding loop).

2. **`review.submitted`, on the human path only**, after you submit the review to a `Gate` and get a
   `reviewId` back. Warrant's own reference consumer does exactly this in
   `packages/warrant-eve/src/approval.ts`'s human-path branch of `buildApproval`: submit, then append `{requestId, reviewId, content}`.
   See [`gate.md`](gate.md) for the port, and note §8 of that file before you assume your content will fit.

After `guardedExecute` you owe the ledger **nothing**: it writes `action.executed`
(the ledger append that spends the nonce, in `guardedExecute`) and `action.outcome` (the final ledger append in `guardedExecute`, before the effect's result is returned) itself, on both the
success and the failure path. **Do not append either yourself.** A second `action.executed` for the same
nonce is refused as `nonce_spent` anyway ([`ledger.md`](ledger.md) §5), but a second one under a
*different* nonce is a second authority claim nobody authorized.

## 4. `guardedExecute`: the enforcement seam

```ts
// packages/warrant-guard/src/guarded-execute.ts: guardedExecute
export async function guardedExecute<T, R>(
  warrant: Warrant,
  rawParams: unknown,
  schema: ZodType<T>,
  deps: GuardDeps,
  effect: (params: T) => Promise<Result<R, WarrantError>>,
): Promise<Result<R, WarrantError>>

// packages/warrant-guard/src/guarded-execute.ts: GuardDeps
export interface GuardDeps {
  publicKeyHex: string;
  ledger: Ledger;
  now: () => Date;
  outcomeStatus: string;
}
```

**You own two things: the schema and the effect closure. Warrant owns everything between them**
(see the doc comment above `guardedExecute` in `guarded-execute.ts`). Your call site holds no hashing, no nonce handling and no ledger writes:

```ts
import { guardedExecute } from '@idriszade/warrant-guard';

return guardedExecute(warrant, rawParams, MyParamsSchema, deps, async (params) => {
  // the effect, and nothing else.
});
```

Three things about the signature that are decisions, not accidents (and are argued in
[`millwerk-warrant-seam.md`](millwerk-warrant-seam.md) §3):

- **No `principal` in `deps`.** The warrant already binds one and replay correlates on it; the guard
  appends under `warrant.principal` and accepts no other (the `principal: warrant.principal` field of the `action.executed` append in `guarded-execute.ts`, and the comment above it explaining why).
- **Generic in `R`, not `void`.** Your effect's own result comes back to you.
- **`outcomeStatus` is yours**: your word for success, `'queued'`, `'sent'`, `'opened'`
  (the `outcomeStatus` field's doc comment in `GuardDeps`, `guarded-execute.ts`). The guard supplies `'failed'` itself, because failure is not a vendor
  concept (the `action.outcome` append's `status` field in `guarded-execute.ts`).

### What flows into the effect

**The handler must run on the authorized params, never on the caller's raw input.** Your adapter
translates the caller's input into `action.params` on the way in; that is the value `requestAuthority`
hashes into the warrant. So the value your `effect` closure acts on has to be the same bytes back: the
`params` argument `guardedExecute` hands it, parsed and stripped, never something the closure still
has lying around from before the translation. Getting this backwards is how a reviewer's edit gets
approved and the unedited version executes anyway: the entire point of the human path is that params
can change between request and execution, and an effect that closes over the pre-review value defeats
that silently, with no error anywhere in the chain.

Two adapters pin this the same way, and both had to remove a cast to get there. `warrant-mcp`'s
`governTool<I, T>` takes an `McpTool<T>` in and hands back an `McpTool<I>`: the tool that actually runs
is typed over `T`, the authorized params, never over the caller's `I`
(the `McpTool<I>` interface and its doc comment in `packages/warrant-mcp/src/types.ts`). Its effect closure calls `tool.handler(params)` with the
`params: T` that `guardedExecute` parsed, never the outer `args: I` still in scope from the request
build (the `effect` closure in `governTool`'s auto-path branch, and the comment above it about the removed cast, in `packages/warrant-mcp/src/govern-tool.ts`); the comment there records that this used to
read `params as unknown as I`, and every fixture made `I` and `T` structurally identical, so nothing
ever failed and the cast went on claiming a property the code did not have. `warrant-eve`'s
`execute.ts` carries the same discipline at a call site outside `guardedExecute` itself: `ToolLike<P,
O>` is declared by this interface, not by `eve/tools`, specifically so a tool handler cannot be typed
over the caller's input even by accident (the `ToolLike<P, O>` interface and its doc comment in `packages/warrant-eve/src/execute.ts`), and
`tool.execute(params, ctx)` runs on the value read back off the ledger or produced by `toParams`, never
on `input` (the `params` binding and the `tool.execute(params, ctx)` call in `buildExecute`, `packages/warrant-eve/src/execute.ts`).

**The corollary, and the part people actually miss: the translation's output must be exactly the shape
the effect expects, not merely the fields policy cares about.** A binding that projects, renames or
drops a field is legitimate (policy may only need a subset of what the caller sent), but then the
effect must be typed over the projection, not over the caller's original input, or a renamed field
reads back as `undefined` at runtime with no compiler in the loop to catch it. `warrant-eve`'s
`WarrantToolBinding<I, P = I>` names this directly: `P` is "what `toParams` produces: the value the
warrant's `paramsHash` is taken over, and therefore the only value the tool's own handler is ever
allowed to run on… a binding that projects, renames or drops a field names its own `P`, and then the
handler must be typed over that, which is what makes the mismatch a compile error instead of an
`undefined` read at runtime" (the doc comment above `WarrantToolBinding<I, P = I>` in `packages/warrant-eve/src/deps.ts`). A dedicated test pins both
halves of this: a renamed field no longer compiles, and a handler typed over the caller's input no
longer compiles against a projecting binding
(the `a binding whose toParams does not produce what the handler reads` describe block in `packages/warrant-eve/tests/binding-params-typing.test.ts`).

**Naming `P` only closes this for a dropped *required* field. A dropped *optional* one still compiles,
silently, unless `P` is named explicitly.** Left at the default (`P = I`), a projection that drops an
optional field still structurally satisfies `I`, so nothing objects at the call site; the handler's type
goes on claiming it might read a field the warrant never bound. The outbound demo's `gtmBinding` was the
live instance of exactly this: left as `WarrantToolBinding<DemoInput>` it compiled, because
`{to, subject, body}` satisfies `DemoInput` once `audience` is optional on it. Naming `P` as
`EmailContent` (the narrower type, not the caller's input) is what turns `input.audience` inside the
handler into a compile error instead of an `undefined` read
(the `gtmBinding` declaration and its preceding comment in `packages/warrant-eve-outbound-demo/src/build.ts`).

### The locked order

`parse → verifyWarrant → recompute paramsHash → compare → spend nonce → act → record`
(the module doc comment's sequence line, `guarded-execute.ts`).

**Parsing comes first**, and this is the one ordering people get backwards. The authority check hashes
**final** params, and stripping is what makes them final: hashing the raw input instead would let an
extra key move the digest while your effect never sees it (the comment preceding the `verifyAuthorizedParams` call explaining the ordering, in `guarded-execute.ts`). `safeParse`, not
`parse`: a schema failure is a refusal, not an exception (the comment above the schema-parse branch in `guarded-execute.ts`).

**The nonce is spent before the effect runs** (the `action.executed` ledger append in `guardedExecute`, which spends the nonce before `effect` runs). If your send fails the nonce
is burned and the warrant cannot be retried. That is fail-closed on purpose: *a burned nonce with no side
effect is strictly safer than a reusable warrant retried into a double-send*
(the doc comment above `guardedExecute` making this argument, in `guarded-execute.ts`). The failure is recorded in `action.outcome`, so the burn is never a silent
gap.

If the ledger append fails, **the effect does not run**: *no record, no act* (the `if (executed.error) return err(...)` guard, with its "No record, no act" comment, in `guarded-execute.ts`).

### Error codes

| Code | Type | Where | Meaning |
|---|---|---|---|
| `invalid_params` | `validation` | the `invalid_params` return in the schema-parse branch of `guarded-execute.ts` | your schema rejected `rawParams`; the message lists the issues |
| `params_mismatch` | `integrity` | the `params_mismatch` return in `verify-authorized-params.ts` | the digest of the final params is not the digest the warrant binds |
| `params_noncanonical` | `integrity` | the `params_noncanonical` return in `verify-authorized-params.ts` | the final params could not be canonicalised at all. **Distinct from the row above**: see below |
| `run_mismatch` | `integrity` | the `run_mismatch` return in `verify-authorized-params.ts` | not reachable through `guardedExecute`, which passes `expectedRunId: null` (the `verifyAuthorizedParams` call in `guarded-execute.ts`) |
| whatever `verifyWarrant` returns | n/a | the `verifyWarrant` call and its error propagation in `verify-authorized-params.ts` | bad signature, expired, malformed warrant |
| `effect_threw` | `permanent` | the `catch` block wrapping the `effect` call in `guarded-execute.ts` | your effect threw instead of returning an error. The outcome is still recorded |
| `outcome_append_failed` | `transient` | the `outcome_append_failed` return after a successful effect, in `guarded-execute.ts` | the effect succeeded but `action.outcome` did not land. **Not success** |
| plus every `Ledger` code | n/a | [`ledger.md`](ledger.md) §5 | `nonce_spent`, `noncanonical_payload`, `db_error` |

**Two subtleties worth knowing before you write your mapping:**

- **The effect's error wins** over a bookkeeping failure (the `if (outcome.error) return err(outcome.error)` check in `guarded-execute.ts`). It is the one that
  says whether the side effect happened, which is what you actually have to know.
- **`params_noncanonical` does reach you through `guardedExecute`, and it is not the same fact as
  `params_mismatch`.** Both arrive as themselves, exactly as the two `warrant-eve` call sites and the
  drainer have always reported them (the `params_noncanonical` / `params_mismatch` branch in `warrant-eve/src/execute.ts`, and the same branch in `warrant-eve/src/drainer.ts`).

  **Map them separately.** `params_mismatch` means the bytes canonicalised fine and hashed to
  something other than what was signed: *somebody changed the payload after it was authorized*, and
  it is the most alarming thing this system reports. `params_noncanonical` means the bytes could not
  be canonicalised at all: a structural fault in the caller's own params, no adversary implied. Both
  are fail-closed, so a caller that recognises neither still refuses, but an adapter that words them
  identically has thrown away the only signal that distinguishes an attack from a bug.

## 5. What these primitives deliberately do not do

### `requestAuthority` stops before the Gate, on purpose

On a `human` verdict it returns and stops (Step 5 in `requestAuthority`). **It does not submit a review, and
a `Gate` must never be pulled into it** (the "Why it stops before the Gate" section of the module doc comment in `request-authority.ts`).

The reason is a boundary, not a convenience: **submitting a review needs review *content*, and content is
domain-shaped.** The register puts human decision content in Gatewerk (§2, *"Can a person type into it?"*).
Pulling a `Gate` in here would drag review presentation into a primitive whose entire claim is that it
knows nothing about the runtime calling it, and the first adapter with an awkward content shape would start
bending the function toward itself.

**That claim is enforced, not asserted.** `packages/warrant-authorize/tests/runtime-blind.test.ts` pins the
dependency set to exactly four packages (the `declares exactly the four dependencies the sequence needs` test), asserts `@idriszade/warrant-gatewerk` and `eve` are
absent from *every* dependency field (the `depends on no Gate and on no agent runtime, in any dependency field` test), scans the source for an import of either (the `imports no Gate and no agent runtime anywhere in src` test),
and runs a **word-boundary** scan over the source including comments (the `names no runtime or domain word anywhere in src` test). The scan is word-boundary
anchored because the most important forbidden word is three letters and matches *evaluate*, *event*,
*review*, *never*, *level* and *however*; there is a test asserting the scan is **not vacuous** (the `the word-boundary scan is not vacuous` test).
**Do not replace it with a substring scan.**

So the split is: **`requestAuthority` owns the proof spine of authorization; you submit the review and
append `review.submitted`.** The ledger is complete at the handover: `warrant.requested` and
`policy.evaluated` are already written.

Before you design your review content, read [`gate.md`](gate.md) §8. The `Gate` port's `content` field is
currently email-shaped, which is an open problem and not something to route around locally.

### `guardedExecute` knows nothing about what your effect does

`packages/warrant-guard/tests/vendor-blind.test.ts` pins the dependency set to exactly four
(the `declares exactly the four dependencies the sequence needs` test), fails on any vendor, transport or domain word anywhere in the source **including comments**
(the `names no vendor, transport, or domain anywhere in src` test), asserts the guard constructs **no schema of its own** (the `defines no schema of its own: the actuator owns the shape` test); it takes a `ZodType` and never
builds one), and asserts no filesystem, network, clock or randomness (the `performs no I/O of its own beyond the injected ledger` test).

The consequence for you: **an actuator that finds the guard awkward must fix the actuator or change this
contract deliberately. It cannot special-case itself into the guard.**

### `verifyAuthorizedParams` exists, and you do not call it

`@idriszade/warrant-guard` also exports `verifyAuthorizedParams(warrant, finalParams, deps)`
(the `verifyAuthorizedParams` function signature in `packages/warrant-guard/src/verify-authorized-params.ts`, exported from `warrant-guard/src/index.ts`). It is the
security core (`verifyWarrant` → optional `runId` check → recompute `paramsHash` → compare), factored out
because **three** paths to a side effect run it, not one:

| Call site | Where | Why its shape differs |
|---|---|---|
| `guardedExecute` | the `verifyAuthorizedParams` call in `guarded-execute.ts` | returns a `Result` and spends a nonce |
| `warrant-eve`'s `execute` | the `verifyAuthorizedParams` call in `buildExecute`, `warrant-eve/src/execute.ts` | throws, and its authority was already spent |
| the outbox drainer | the `verifyAuthorizedParams` call in `drainRow`, `warrant-eve/src/drainer.ts` | records a refusal outcome |

Folding three positions into one pipeline would force one shape onto all three; leaving the security core
copied three times is how a guard quietly stops being a guard. **`guardedExecute` already calls it.** It is
documented here only so that a future session reaching for *"I need to check a warrant against some params"*
finds the existing primitive instead of writing a fourth copy of the compare.

Note `AuthorityCheckDeps.expectedRunId` is `string | null`, **required and nullable rather than optional**
(the `expectedRunId` field's doc comment in `AuthorityCheckDeps`, `verify-authorized-params.ts`): *"no run check" must be a written decision at each call site, not a
default someone forgets.* `guardedExecute` passes `null` and says why (the comment above `expectedRunId: null` in `guarded-execute.ts`).

### `mintHumanWarrant` is deliberately not `requestAuthority`

`warrant-eve/src/resume-issue.ts` also issues a warrant and is **not** a caller of `requestAuthority`. It
runs *after* a human decided, re-evaluating content that may have been **edited** since the request, and
issues with `path: 'human'` plus a `reviewRef`. It must not append `warrant.requested`, because the request
was recorded before the review; and its verdict comes from a human decision rather than a fresh policy
path. A primitive whose contract begins *"record the request"* cannot express that. **The duplication is
deliberate and recorded**: register §2, *One shared authority check, three positions in the pipeline*.

## 6. Standing prohibitions

These are not style preferences. Each one has a written reason and, in most cases, a test that fails.

1. **Never write a fourth guard, or a third approval path.** Any new path to a side effect calls
   `guardedExecute`. Any new path to authority calls `requestAuthority`. If either does not fit, change its
   contract deliberately: do not fork it locally. Both packages' blindness tests exist to make the lazy
   option fail loudly. **A duplicate actuator is a Tuesday;
   a duplicate guard is a vulnerability** (the module doc comment in `guarded-execute.ts`).

2. **Never reimplement or vendor `canonicalJson`.** There is exactly one, in `warrant-core`
   (the `canonicalJson` export in `packages/warrant-core/src/index.ts`), and it defines **identity**. The ledger's `entryHash` runs
   every entry body through it (the `entryHash` function in `packages/warrant-ledger/src/entry.ts`) and `paramsHash` is built on
   it, so a second implementation that disagreed by one byte would invalidate every certificate ever
   issued, silently, because both sides would still verify against themselves. Vendoring is
   **forbidden**; Millwerk consumes the real function by `file:` path and
   injects it at its call sites so a second cannot grow.

3. **The Merkle fold is duplicated on purpose; `canonicalJson` is single by necessity. Getting these the
   wrong way round is the failure mode.** Millwerk folds to *produce* the trajectory root; warrant folds to
   *check* it (`packages/warrant-verify/src/trajectory.ts`'s `merkleRoot` and `foldInputsRoot` functions). **A
   verifier that imports the producer's fold proves only that the producer agrees with itself.** The two are
   pinned to each other by shared conformance vectors tested on both sides, and a vector is a
   `toBe('…')` literal, not a snapshot. **Never update a conformance vector because it failed:** a vector
   moving means the two folds diverged.

4. **Never add a query or analytics method to `Ledger`.** Invariant 5; [`ledger.md`](ledger.md) §3.

5. **Never write a second ledger posture check.** `assertLedgerAppendOnly` is the one;
   [`ledger.md`](ledger.md) §7.

6. **Never treat `deny` as an error, or a policy refusal as an outage.** §2 above.

7. **Never scan for forbidden words by substring in `warrant-authorize`.** §5 above.

8. **Never call a binding's translation into params, `toParams`, more than once
   for the same request.** The value hashed into the warrant and the value handed to the guard have to
   be the same bytes, and that function is caller-supplied: invoking it twice makes that an assumption
   about someone else's function rather than a property of yours. A binding that reads anything mutable
   (a clock, a counter, a random id) would then produce a `params_mismatch` between the two calls:
   fail-closed, but failing for a reason nobody could find. Same family as the GhostApproval invariant,
   which is about exactly this gap. `warrant-mcp` calls it exactly once and says why at the call site
   (the comment above `binding.toParams(args)` in `packages/warrant-mcp/src/govern-tool.ts`), and a test pins the count
   (the `calls binding.toParams exactly once: the warrant and the guard must hash the same bytes` test in `packages/warrant-mcp/tests/govern-tool.test.ts`).

9. **Never "fix" a binding that emits a key the schema strips by loosening the guard's comparison.**
   `requestAuthority` hashes `request.action.params` as given; `guardedExecute` parses first and hashes
   what survives (§4), so a binding producing a field its own schema does not declare yields two
   different digests and is refused, fail-closed, before the effect ever runs. That refusal is correct:
   the extra key really did make it into the hash `requestAuthority` bound, and really was stripped
   before the effect would have seen it, so comparing against the stripped value would accept a payload
   that was not what was authorized. The fix is always the schema or the binding, never a looser
   comparison. The `refuses fail-closed when the binding emits a key the schema strips` test in
   `packages/warrant-mcp/tests/govern-tool.test.ts` pins the refusal and asserts the
   handler is never called.

## 7. Installing

Packages are consumed by path: warrant is not published, and publishing is the operator's call, not the
agent's. Millwerk's declarations are the working reference
([`millwerk-warrant-seam.md`](millwerk-warrant-seam.md) §3 and §5):

```jsonc
"@idriszade/warrant-core":      "file:../warrant/packages/warrant-core",
"@idriszade/warrant-guard":     "file:../warrant/packages/warrant-guard",
"@idriszade/warrant-authorize": "file:../warrant/packages/warrant-authorize"
```

Both seam packages declare exactly four dependencies each and are pinned as an **exact set**, not a
"does not contain" check: the `dependencies` field of `packages/warrant-guard/package.json`
(`@idriszade/core`, `warrant-core`, `warrant-ledger`, `zod`) and
the `dependencies` field of `packages/warrant-authorize/package.json`
(`@idriszade/core`, `warrant-core`, `warrant-ledger`, `warrant-policy`). If you add a dependency to either,
its blindness test fails and it is meant to.

`Result` comes from `@idriszade/core`, which **is** published; install it rather than copying the union
(seam contract §2). Warrant resolves it at `0.1.0`, and npm's `latest` is several minors ahead. Do not let
a caret drag you forward.

**Two residuals that will bite a public extraction, not a local link**: some packages declare `workspace:*` dependencies, so published dist paths would break
until those are published first and changed to `^0.1.0`. This is confirmed harmless for local `file:`
consumers: npm links such a package without resolving its `workspace:` specifiers, which is why Millwerk
consumes four of these packages successfully.

## 8. A minimal end-to-end shape

```ts
// 1. your proposer attests its inputs FIRST: ordering is yours, not warrant's (§3)
await ledger.append({ runId, at, event: 'trajectory.attested', principal, payload: trajectoryPayload });

// 2. ask
const authority = await requestAuthority(request, deps);
if (authority.error) return mapError(authority.error);   // §2: four codes, do not collapse them

switch (authority.data.path) {
  case 'deny':
    return refused(authority.data.verdict);              // an ok, not an error

  case 'human':
    // warrant stopped here on purpose (§5). You submit, you record.
    // See gate.md, and gate.md §8 before you assume your content fits.
    return parkForReview(authority.data.verdict);

  case 'auto': {
    // 3. act, under the guard. It writes action.executed and action.outcome for you (§3).
    return guardedExecute(
      authority.data.warrant,
      rawParams,
      MyParamsSchema,
      { publicKeyHex, ledger, now, outcomeStatus: 'sent' },
      async (params) => doTheThing(params),
    );
  }
}
```

Everything not shown (hashing, the nonce, the chain, the signature check) is warrant's, and reproducing
any of it locally is the failure this guide exists to prevent.
