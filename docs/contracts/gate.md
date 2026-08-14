# Contract: the `Gate` port

**Status:** read from the code. Owner: Warrant
(`@idriszade/warrant-gatewerk`). Consumer of what it carries: Gatewerk.
**Siblings:** [`ledger.md`](ledger.md) · [`adapter-authors-guide.md`](adapter-authors-guide.md) ·
[`millwerk-warrant-seam.md`](millwerk-warrant-seam.md). Concept ownership lives in
the workspace's boundary register (private) §2 and wins on conflict.

**What the port is for.** The authorization seam stops at a `human` verdict and hands the caller a
decision it is not entitled to make (the human-path return in `requestAuthority`, `warrant-authorize/src/request-authority.ts`). `Gate` is the
two-call interface across which that decision leaves warrant and comes back. Warrant does not decide;
it submits a request and later reads a decision, and everything it does with the answer is about
whether the answer is trustworthy enough to mint against.

**Every citation below names the file and the symbol it refers to, checked against the file it names.**
Line numbers are deliberately not used, since they drift on every rebase, so a citation names a type,
function, guard clause, or comment instead. Where an older doc disagrees, the disagreement is called out
inline.

## 1. The interface: two methods, nothing else

```ts
// packages/warrant-gatewerk/src/types.ts, the Gate interface
export interface Gate {
  submit(r: ReviewRequest): Promise<Result<{ reviewId: string }, WarrantError>>;
  fetchDecision(reviewId: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>>;
}
```

| Method | Cite | Returns | What it must never do |
|---|---|---|---|
| `submit` | `types.ts` | `{ reviewId }`, the identifier a warrant is later anchored to | Fabricate an id. See §5 |
| `fetchDecision` | `types.ts` | a `ReviewDecision`, or `{ pending: true }` | Report a machine decision as a human one. See §4 |

There is no `cancel`, no `list`, no `poll` helper. The port is deliberately narrow for the same reason
`Ledger` is (invariant 5, [`ledger.md`](ledger.md) §3): a wider port is a place for review-management
logic to accumulate on warrant's side of a boundary the register assigns to Gatewerk.

Both methods return `Result`, never throw, and the two shipped implementations honour that by wrapping
their whole body (the `submit` and `fetchDecision` methods in `gatewerk-gate.ts`, each a full
`try`/`catch`). The reason is the same one `requestAuthority` states for itself: a rejected promise on
an approval path is a fail-open.

The exported surface is all of `packages/warrant-gatewerk/src/index.ts`: the four types, the two gates,
the two `SimGate` option types, the webhook verifier, the re-bind helper, and the preflight.

## 2. `ReviewRequest`: what warrant sends

```ts
// packages/warrant-gatewerk/src/types.ts, the ReviewContent alias and the ReviewRequest interface
export type ReviewContent = Record<string, unknown>;

export interface ReviewRequest {
  requestId: string;
  runId: string;
  title: string;
  content: ReviewContent;
  metadata: { paramsHash: string; stakesRuleId: string };
}
```

| Field | Cite | Why it is here |
|---|---|---|
| `requestId` | `types.ts` | Correlates the review to `warrant.requested`. `GatewerkGate` also sends it as `idempotency_key` (`gatewerk-gate.ts`) |
| `runId` | `types.ts` | The run the review belongs to. Millwerk's batch run **is** this `runId`; do not mint a second (register §2) |
| `title` | `types.ts` | Presentation only |
| `content` | `types.ts` | The thing a human reads and may edit. **Opaque (see §8).** Warrant never reads a field of it |
| `metadata.paramsHash` | `types.ts` | The digest of the params the review is about. It is what makes an edit detectable rather than assumed |
| `metadata.stakesRuleId` | `types.ts` | The policy rule that routed this to a human, `outcome.verdict.ruleId`, passed in the `gate.submit` call in `warrant-eve/src/approval.ts` |

`ReviewContent` is `Record<string, unknown>` and the reasoning is in the doc comment above the type in
`types.ts`. The short version:
the register assigns human decision content to Gatewerk, and a concrete type here would be false anyway:
the value arrives over HTTP and `mapReviewDecision` can establish only that it is a non-empty object
(§4, *Edits*). Consumers shape-guard it themselves.

`GatewerkGate.submit` maps this onto Gatewerk's create-review body in the request built in
`gatewerk-gate.ts`: `content` becomes `payload`, `metadata` is widened to carry `runId` and `requestId`
(the `metadata` object in `GatewerkGate.submit`), and two fields are **load-bearing and not
configurable**:

- `oversight: 'blocking'` (`gatewerk-gate.ts`): `'monitoring'` auto-confirms on silence with
  `decided_by: 'system:monitoring_window'`.
- **no `timeout` field at all**, deliberately (the comment above `oversight: 'blocking'` in
  `gatewerk-gate.ts`): `timeout.action:'auto_approve'` produces a machine-made approval. If a timeout
  is ever sent it must be `'expire'`.

The comment above `oversight: 'blocking'` in `gatewerk-gate.ts` states the rule these two obey: this
layer and `decision.ts`'s guard are independent, and **neither may rely on the other holding.**

## 3. The `{pending: true}` polling contract

`fetchDecision` returns a union, not a nullable (the `fetchDecision` signature in `types.ts`). `{ pending: true }` is a *successful*
read that means the human has not decided yet, the same distinction `requestAuthority` draws when it
returns `deny` as an `ok`. A gate outage is an `err`; an undecided review is an `ok`.

Callers discriminate structurally, because `ReviewDecision` carries no `pending` field:

```ts
// packages/warrant-eve/src/resume.ts, inside resumeByPoll (step 5)
if ('pending' in decResult.data) return ok('pending');
```

The statuses that map to pending are a fixed set:

```ts
// packages/warrant-gatewerk/src/decision.ts
const PENDING_STATUSES = new Set(['pending', 'awaiting_iteration', 'awaiting_external', 'monitoring']);
```

returned by the `PENDING_STATUSES` check in `mapReviewDecision`, `decision.ts`. Note `'monitoring'` is
*pending*, never *approved*: a review whose oversight mode auto-confirms on silence never reaches a
decision branch through this path.

**Pending is not a retry hint and carries no schedule.** The port says nothing about how often to
poll, and warrant's own consumer surfaces it as a 503 rather than inventing a result (the
`pending → 503` return in `handleGatewerkWebhook`, `warrant-eve-outbound-demo/src/webhook-handler.ts`,
with the reasoning in the header comment above it). An unrecognised status is **not** pending: it is
`err` with `unrecognized_status` (the `status !== 'decided'` branch in `mapReviewDecision`,
`decision.ts`), which is the fail-closed direction.

## 4. `ReviewDecision`, and what `decidedBy` actually guarantees

```ts
// packages/warrant-gatewerk/src/types.ts, the ReviewDecision interface
export interface ReviewDecision {
  reviewId: string;
  decision: 'approved' | 'edited' | 'rejected';
  editedContent?: ReviewContent;
  decidedBy: string;
}
```

`decidedBy` is **required on every non-pending outcome** (the field in `types.ts`, and the comment
above it says why it is not optional). The guarantee is not "a human string was present." It is:

> **a `ReviewDecision` reaching a mintable outcome carries positive evidence of an authenticated human
> reviewer session, or it was never built.**

That is enforced in exactly one place, `mapReviewDecision` in `packages/warrant-gatewerk/src/decision.ts`,
and it is three layers deep, in this order:

| # | Check | Cite | Direction |
|---|---|---|---|
| 1 | `isHumanAttested(last_action_by)`: must start `reviewer:` and be longer than the prefix | `isHumanAttested` in `decision.ts`, applied in `mapReviewDecision` | **allowlist.** Absence fails closed |
| 2 | `isSystemDecider(decided_by)`: rejects empty, and `system` followed by any non-alphanumeric or end | `isSystemDecider` in `decision.ts`, applied in `mapReviewDecision` | denylist, defence in depth |
| 3 | `isMachineAction(action_value)`: rejects `auto_approve` | `isMachineAction` in `decision.ts`, applied in `mapReviewDecision` | denylist, independent of the decider string |

All three fail with the same code, `human_attestation_missing` (the three matching returns in
`mapReviewDecision`, `decision.ts`). All three run **before** the decision value is branched on (the
comment above the attestation checks in `mapReviewDecision`, `decision.ts`, explains why: Gatewerk's
`closeMaxIterations` writes a rejection-shaped decision alongside a system decider, and branching first
would launder it into a valid human rejection).

The commentary above `isHumanAttested` in `decision.ts` is the load-bearing part and should be read before touching any of
it: `decided_by` is the **wrong column** to attest a human on, because Gatewerk's own api-key paths write
the raw actor id into it and let an agent actor overwrite it. `last_action_by` is the field Gatewerk
maintains as `'<kind>:<id>'`, and only `reviewer` is an authenticated human session. Layer 1 exists
because layers 2 and 3 have each already been wrong once.

**The one place a system decider is allowed** is the `expired`/`archived` branch in `mapReviewDecision`,
`decision.ts`: `expired` and `archived` map to `decision: 'rejected'` with `decidedBy:
'system:${status}'`. A system identity may deny. It may never approve.

**A fourth layer prevents rather than detects.** `preflightGatewerkTemplate` in
`packages/warrant-gatewerk/src/preflight.ts` refuses to start a governed run at all when the
configured template can decide itself: the `auto_approve === true` check raising
`preflight_template_auto_approve`. The header comment in `preflight.ts` explains the gap it closes: Gatewerk's per-template `auto_approve`
fires at review **create**, from server-side config warrant never sends, so by the time layers 1-3 can
speak the review is already decided. Only not starting closes that.

### Edits

`editedContent` (the field in `types.ts`) is optional and **authoritative whenever present, independent
of the decision value** (the `hasEdits` branch in `mapReviewDecision`, `decision.ts`). Gatewerk's human
surfaces send `decision: 'approved'` carrying an `edited_payload`; they never send `'edited'` (the
comment above the edited-content branch in `mapReviewDecision`, `decision.ts`). Treating edits as
significant only under `decision === 'edited'` silently discarded a reviewer's corrections: the warrant
minted over the *original* params while the certificate attested a human approved. An explicit `'edited'`
with nothing to apply is incoherent and fails closed as `edited_no_content` (the `edited_no_content`
branch in `mapReviewDecision`, `decision.ts`).

**What `mapReviewDecision` establishes about `edited_payload` is only that it is a non-empty object**
(the `hasEdits` check and the cast beneath it in `mapReviewDecision`, `decision.ts`). That is the whole
check. It was already the whole check while `editedContent` claimed to be `{subject, body, to}`, which
is why the concrete type was never load-bearing and why §8 could remove it without weakening anything.

An edit routes through `rebindParamsForEdit` in `packages/warrant-gatewerk/src/rebind.ts`, which
**replaces, it does not merge, and returns; the caller recomputes `paramsHash` and mints against
it** (the doc comment on `rebindParamsForEdit` about the caller recomputing `paramsHash`, in
`rebind.ts`). That is the GhostApproval binding: the warrant must be bound to the bytes the
human actually authorized.

> `rebindParamsForEdit` **replaces, it does not merge.** Replacement is the fail-closed direction, since a
> partial edited payload loses the keys it omits and the caller's shape guard then rejects it, where a
> merge would back-fill them into a combination no human saw whole. `tests/rebind.test.ts` pins it with a
> key present in the original and absent from the edit.

The caller's obligation is not optional. `rebindParamsForEdit`'s output is data the Gate supplied and no
type constrains it; `warrant-eve` shape-guards it before it becomes params (`isEmailContent` in
`warrant-eve/src/resume-issue.ts`, applied fail-closed in `mintHumanWarrant`'s shape guard).

## 5. The two implementations

| | `GatewerkGate` | `SimGate` |
|---|---|---|
| Cite | `gatewerk-gate.ts` | `sim-gate.ts` |
| For | the live Gatewerk API | local dev and e2e |
| `submit` | `POST {baseUrl}/api/v1/reviews` (`GatewerkGate.submit`, `gatewerk-gate.ts`) | in-memory, id `sim-${idx}` (`SimGate.submit`, `sim-gate.ts`) |
| `fetchDecision` | `GET {baseUrl}/api/v1/reviews/{id}` → `mapReviewDecision` (`GatewerkGate.fetchDecision`, `gatewerk-gate.ts`) | script lookup (`SimGate.fetchDecision`, `sim-gate.ts`) |
| `decidedBy` | whatever survives §4 | the literal `'sim-reviewer'` (`sim-gate.ts`) |
| Config | injected, **no `process.env` reads** (comment in `gatewerk-gate.ts`) | a `ScriptEntry[]` plus `SimGateOptions` (constructor in `sim-gate.ts`) |

**`SimGate` does not know how to edit anything, and that is the point.** An `'edit'` script entry
requires an injected `editContent: SimEdit` (the `SimEdit` type and `SimGateOptions.editContent` field
in `sim-gate.ts`); the constructor **throws** when the script contains `'edit'` and none was supplied
(the constructor's throw in `sim-gate.ts`). It refuses at *construction* rather than at `fetchDecision`
so a wiring mistake lands where its author is looking, not several awaits later inside the code under
test, and it throws rather than returning a `WarrantError` so no public error code exists that only a
misconfigured harness can reach. What a human edits is domain knowledge, and a simulator that invented
one would be exactly the defect §8 records. Pinned by `tests/sim-gate.test.ts`'s tests for editContent
pass-through, construction-time refusal, and no-edit-needed construction.

`GatewerkGate`'s template slug is **required, with no default** (the `templateSlug` constructor field and
its assignment in `gatewerk-gate.ts`): the caller says it, rather than the package choosing a domain
word for the caller.

**`SimGate` never returns `{pending: true}`.** Every stored review resolves on the first fetch. A caller
whose only exercise is `SimGate` has never run its pending branch; that is what the ceremony is for.

### Error codes across both gates

| Code | Type | Raised at | Meaning |
|---|---|---|---|
| `gatewerk_api_error` | `transient` | `gatewerk-gate.ts` `submit` and `fetchDecision`; `sim-gate.ts` `fetchDecision` | non-2xx from Gatewerk, or an unknown `reviewId` in `SimGate` |
| `gate_unreachable` | `transient` | `gatewerk-gate.ts` `submit`/`fetchDecision` catch blocks; `preflightGatewerkTemplate`'s fetch catch in `preflight.ts` | `fetch` threw |
| `gatewerk_missing_review_id` | `validation` | the missing-id guard in `GatewerkGate.submit`, `gatewerk-gate.ts` | the create response carried no usable id |
| `unrecognized_status` | `validation` | the two `unrecognized_status` returns in `mapReviewDecision`, `decision.ts` | response was not an object, or status is not a known one |
| `unrecognized_decision` | `validation` | the final `unrecognized_decision` return in `mapReviewDecision`, `decision.ts` | status was `decided` but the decision value is unknown |
| `human_attestation_missing` | `validation` | the three matching returns in `mapReviewDecision`, `decision.ts` | one of the three §4 layers refused |
| `edited_no_content` | `validation` | the `edited_no_content` return in `mapReviewDecision`, `decision.ts` | `decision: 'edited'` with no `edited_payload` |
| `preflight_template_missing` / `_ambiguous` / `_auto_approve` / `_timeout_auto_approve` / `_indeterminate` / `_list_paged` | see `preflight.ts` | each guard clause in `preflightGatewerkTemplate`, `preflight.ts`, matched by error code | the template cannot be certified as non-self-deciding |

The `matches.length > 1` check in `preflightGatewerkTemplate`, `preflight.ts`, is worth naming: **two
templates sharing a slug is `preflight_template_ambiguous`, not "take the first."** Gatewerk holds a
uniqueness constraint, which is exactly why this client refuses to assume it: two rows means one of
them is unaudited.

### Not on the port, but in the package

`verifyGatewerkWebhook` (`verifyGatewerkWebhook` in `webhook.ts`) verifies inbound decision deliveries
across three schemes (`WebhookScheme` and `DEFAULT_SCHEMES` in `webhook.ts`), preference order
`standard, v2, v1` with `v1` last because it carries no timestamp and so no replay protection. Default
tolerance 300 s (`DEFAULT_TOLERANCE_MS` in `webhook.ts`), applied with `Math.abs` so a *future*-dated
timestamp is rejected exactly like a stale one (the `withinTolerance` function in `webhook.ts`).
It never throws (the catch block in `verifyGatewerkWebhook`, `webhook.ts`). `verifyWebhookSignature`
(`verifyWebhookSignature` in `webhook.ts`) is deprecated (the `@deprecated` tag on
`verifyWebhookSignature`, `webhook.ts`) and kept only for existing callers.

## 6. Two sim-only minors, checked against the code

1. **"SimGate script-overrun defaults to approve": TRUE, and it is sim-only.**
   `sim-gate.ts` reads `this.#script[idx] ?? 'approve'`, so a submit past the end of the script is
   approved. Pinned by `tests/sim-gate.test.ts` ("out-of-bounds script index defaults to approve"),
   so it is intended behaviour, not an accident. It stays a minor only because `SimGate` is a test
   double: the same default in `GatewerkGate` would be the whole vulnerability class §4 exists to close.
   Note the default is `'approve'` and never `'edit'`, which is what makes the unreachable `throw` in
   `SimGate.fetchDecision`, `sim-gate.ts`, genuinely unreachable rather than merely unlikely.

2. **A missing review id never yields a fallback `'unknown'`.**
   The missing-id guard in `GatewerkGate.submit`, `gatewerk-gate.ts`, returns
   `err({type:'validation', code:'gatewerk_missing_review_id'})` on a missing or blank id, with the
   reason in the comment above it: *this id later anchors a warrant, and a fallback value would let an
   incident silently mint against the wrong review.* There is a test asserting the string literal
   `'unknown'` appears **nowhere** in that file (the `'unknown' appears nowhere` test in
   `packages/warrant-gatewerk/tests/gatewerk-gate.test.ts`). This belongs to `GatewerkGate`, the
   live gate, not to `SimGate`.

## 7. Who consumes this port

| Package | Cite | How |
|---|---|---|
| `@idriszade/warrant-eve` | the `@idriszade/warrant-gatewerk` dependency line in `packages/warrant-eve/package.json` | `deps.gate: Gate` (`WarrantEveDeps.gate` in `warrant-eve/src/deps.ts`); submits in the `deps.gate.submit` call in `src/approval.ts`; reads `ReviewDecision` via the import and the `decision: ReviewDecision` field in `mintHumanWarrant`'s options, both in `src/resume-issue.ts` |
| `@idriszade/warrant-eve-outbound-demo` | the `@idriszade/warrant-gatewerk` dependency line in `packages/warrant-eve-outbound-demo/package.json` | `GatewerkGate` for the ceremony (the import in `src/ceremony-deps.ts`), `SimGate` for the demo (the import in `src/build.ts`) |
| ~~`@idriszade/warrant-pack-gtm`~~ | *(none)* | **Dependency dropped.** It was declared and never imported: no reference in its `src/` or `tests/`. A dependency edge with no code behind it, on a package that extracts publicly |

Outside the repo, pursuit's `warrant-agent-outbound` consumes warrant packages by `link:` path; changing
this package's public surface breaks such consumers silently until their suites run.

`warrant-authorize` is **not** on this list and must never join it. It depends on no Gate, asserted
across every dependency field and by an import scan (the two `warrant-gatewerk` absence assertions in
`packages/warrant-authorize/tests/runtime-blind.test.ts`).

## 8. `content` is opaque

`ReviewRequest.content` and `ReviewDecision.editedContent` are `ReviewContent = Record<string, unknown>`
(the `ReviewContent` alias, the `ReviewRequest.content` field, and the `ReviewDecision.editedContent`
field, all in `types.ts`). `rebindParamsForEdit` is field-blind (`rebindParamsForEdit` in `rebind.ts`).
`SimGate` takes an injected `SimEdit` and refuses a script it cannot honour (the `SimEdit` type and the
constructor's throw in `sim-gate.ts`). `WarrantToolBinding.toReviewContent` returns `ReviewContent`
(`toReviewContent` in `WarrantToolBinding`, `warrant-eve/src/deps.ts`), so a binding is not obliged to
produce an email. Warrant reads no field of `content` anywhere: `GatewerkGate.submit` passes it whole
into `payload` (`payload: r.content` in `GatewerkGate.submit`, `gatewerk-gate.ts`), and
`mapReviewDecision` checks only that an edit is a non-empty object (the `hasEdits` check in
`mapReviewDecision`, `decision.ts`).

**Opaque, not generic.** `Gate<C>` was considered and rejected. The value it would type crosses a trust
boundary: it arrives over HTTP and is cast in `mapReviewDecision`, `decision.ts`, so every consumer
must shape-guard it at runtime regardless, and `warrant-eve`'s `isEmailContent`
(`isEmailContent` in `warrant-eve/src/resume-issue.ts`) already does so. A type parameter would
therefore *move* the declaration rather than remove it, threading through six
call sites in `warrant-eve` to buy a guarantee nothing is entitled to rely on. **The argument that would
beat this:** a consumer inside warrant's own packages that needs compile-time exhaustiveness over content
fields. There is none today; if one appears, `Gate<C = ReviewContent>` is the shape to reach for, and it
is backward compatible.

`GatewerkGate`'s template slug is a **required** constructor field with no default (the `templateSlug`
constructor field and its assignment in `gatewerk-gate.ts`). `warrant-eve`'s `EmailContent` /
`mintHumanWarrant` still type the *runtime adapter's* content as an email (`EmailContent` and
`mintHumanWarrant` in `warrant-eve/src/resume-issue.ts`). Neither is on the `Gate` port:
`warrant-eve` is deliberately not a kernel package; it is warrant's adapter to one agent runtime,
where a domain shape is defensible in a way it never is on the port itself.
