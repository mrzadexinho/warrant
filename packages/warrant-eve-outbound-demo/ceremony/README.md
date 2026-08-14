# The Warrant x eve ceremony: what it proves, and what it does not

> **Status: RUN, COMPLETE, AND ATTESTED: 2026-08-01/02 UTC.** The four artifacts are present in
> this directory and `certificate.dsse.json` verifies with the bundled `warrant-verify` CLI and
> the public key below, exit 0, chain intact over 38 entries.

## What was actually run

- **Date:** run fired 2026-08-01 23:56 UTC; human approval and mint 23:59; resume, re-entry guard,
  execute and outcome the same minute; `drain` sent 2026-08-02 00:11 UTC, inside the warrant's
  one-hour TTL; delivery confirmed in the recipient inbox (screenshot, 2026-08-01 19:09 local).
- **Run:** `wrun_01KYZW3GABHYGXW3AW6FWNQ3KS`, review `gw_rev_LPvYfaTKft1kwmbpEBa7X0fg`
  (eval Gatewerk), decided by `admin@gatewerk.local` in an authenticated UI session. Ledger seq
  31–38; send attested at seq 38 with the provider messageId.
- **Recipient:** the operator's own address, on the allowlist (redacted in prose; the full
  addresses are in the signed `ledger.json`, where redaction is impossible by design: editing a
  signed entry breaks verification, which is the product working). Sender: a dedicated address on
  the operator's domain, over authenticated SMTP submission.
- **Public key (hex, self-asserted: see the trust caveats below):**
  `f0959d2deec03d5bbd3291ec7df135bbd187af6c2cabe616d700a8d8349f7a44`
- **To check it yourself** (from this `ceremony/` directory; build the CLI first with
  `pnpm --filter @idriszade/warrant-verify build` if `dist/` is absent):
  `node ../../warrant-verify/dist/cli.js ledger.json --verify-dsse certificate.dsse.json --key <the hex above>`
  *(This line said `../warrant-verify/` until 2026-08-13. A path that fails from the directory
  this README lives in. Found by an adversarial reviewer checking a roadmap that had copied the
  command verbatim; the successful verifications had all quietly used the correct `../../`.)*
- **Honesty notes, unsoftened:** the ledger also contains two earlier runs (seq 17–23, 24–30) that
  were human-approved and minted but never executed: they died on the W-39 re-entry defect (no
  guard, then a stale running image; warrant `DECISIONS.md` W-39). Their warrants expired unused.
  Nothing below this section has been weakened, and the two failed runs are in the signed snapshot
  like everything else.

A governed eve agent takes an instruction, decides under a deterministic policy that an outbound
email needs a human, creates a real Gatewerk review, parks, resumes on a real human decision
delivered by a real webhook, sends a real email through a governed drainer, and produces a
DSSE-signed in-toto certificate that a third party can check with Node and one bundled file.

That is the claim. The rest of this document is the part most vendors leave out.

## What the certificate actually proves

1. **The chain is intact.** Every ledger entry hashes its predecessor, and `verifyChain` walks it.
2. **The actions matched the policy.** `replayRun` folds the run and reports any action that
   executed without authorization, or after a denial, as a violation. A run with violations still
   prints its report, and the verifier still exits non-zero.
3. **A named human decided.** `decidedBy` is carried from Gatewerk into `review.decided` and
   `warrant.issued`, so the proof says *this person approved*, not merely *someone did*.
4. **The bytes that were sent are the bytes that were authorized.** The drainer re-hashes the
   outbox row and compares it to `warrant.action.paramsHash` before handing anything to SMTP.
5. **It checks outside this repository.** `warrant-verify` ships as a self-contained esbuild bundle;
   verification needs Node and that one file, not a pnpm workspace and a TypeScript loader.

## What it does not prove

**The `keyid` is self-asserted.** `dsse.ts` puts the raw public-key hex in `keyid`. Anyone can check
the signature; nobody learns *whose* key it is. There is no certificate chain and no transparency
log. The public key is published here, out of band. Trust in the key is trust in the publisher.

**A hash chain does not survive an attacker with write access to the table.** `entryHash` is an
unkeyed SHA-256 over the entry body, so anyone who can `UPDATE` or `DELETE` rows can recompute the
whole chain and leave it internally consistent. `verifyChain` would pass over a rewritten history.
Tamper-*evidence* holds against casual modification and against anyone without database write
access. It does not hold against the database credential itself. What makes a *snapshot*
non-forgeable is the DSSE signature, and only as of the moment it was signed.

Two mitigations are implemented, and both have limits worth stating:

- The application role holds `INSERT` and `SELECT` and nothing else. `UPDATE`, `DELETE` and
  `TRUNCATE` are revoked, a `BEFORE UPDATE OR DELETE` row trigger raises `42501`, and a
  `BEFORE TRUNCATE` statement trigger does the same (a row trigger cannot see `TRUNCATE`, and
  `REVOKE TRUNCATE` does not bind the owner). `warrant-ceremony preflight` verifies all of it
  against the live database before the run and refuses to proceed otherwise.
- **Neither the trigger nor the REVOKE binds the table OWNER or a superuser**, who can
  `DROP TRIGGER` or `ALTER TABLE ... DISABLE TRIGGER`. The property is real only because the app
  role does not own the table, and the preflight fails the run outright when it does. An audit
  table owned by the role that writes to it has no append-only property, however many triggers
  sit on it.
- The certificate is signed promptly. The live table is not the artifact; the signed snapshot is.

**The run is single-operator and self-attested.** The certificate proves the chain is intact and the
actions matched the policy. It does not prove an independent party observed any of it.

**The drainer has a residual double-send window.** It sends, then appends
`action.outcome{status:'sent'}`. If that append fails, the email has left and the ledger has no
record of it, so a later drain pass finds no terminal outcome and would send again. The drain result
reports `outcome_append_error` precisely so the state is visible rather than silent, the row is
deliberately *not* retired so it stays inspectable, and an advisory lock stops two drainer
*processes* interleaving. A crash in that window is still not closed. Closing it properly means
claiming before sending, which trades a possible double send for a possible false `sent`. That is
probably the better trade for outbound email, and it is recorded as open work, not as done.

**The `oversight: 'blocking'` setting is what enables the auto-approve path it also defends against.**
Gatewerk stamps `decided_by: "system/auto-approve"` at review CREATE when the template has
`auto_approve: true` and oversight is not `monitoring`. Warrant defends in three independent layers,
and none may rely on another: never submitting `monitoring` or `timeout.action: 'auto_approve'`;
rejecting any decider matching `^system([^a-z0-9]|$)` or any review whose `action_value` is
`auto_approve`; and the preflight refusing to start when the configured template auto-approves. Only
the third prevents rather than detects.

**The preflight is point-in-time, and it narrows the window rather than closing it.** Gatewerk's
`PUT /api/v1/templates/:id` can flip `auto_approve` to true at any moment. Between a passing
preflight and the review being created, nothing pins the template, so a change in that window
produces an auto-decided review and the second layer, `mapReviewDecision`, is the only thing left.
The honest claim is that the preflight removes the case where the template was already misconfigured
before anyone started, which is the case that actually happens.

**The template's `timeout_seconds` is inherited even though we never send a timeout.** Gatewerk
computes `data.timeout?.seconds || tpl.timeout_seconds` at create and writes `expires_at` from it,
so a template default silently applies. The review's `timeout_action` is *not* inherited on this
path, so at expiry the worker falls back to `expire`, and warrant reads an expired review as a
rejection. Fail-closed, but it kills a live run for no visible reason, so the preflight refuses to
start when the template carries any timeout default.

**The model is not part of the trust boundary.** The agent runs on OpenAI through `@ai-sdk/openai`.
That is deliberate: the same policy, ledger, certificate and verifier already run under the
Anthropic-based reference runtime, so a second vendor is evidence the neutrality claim covers models
as well as frameworks. It is not evidence that the model behaved well. Nothing here depends on that.

**`fixtures/reference-proof.golden.json` is a frozen snapshot with no generator.** Parity against it
is structural, not cryptographic.

## Running it

```bash
cd stack/warrant/packages/warrant-eve-outbound-demo

pnpm ceremony keygen --print-private     # fresh keypair; put the private half in the env, publish the public half here
pnpm ceremony preflight                  # template is not auto-approve, ledger is genuinely append-only
# ... trigger a run, decide it in Gatewerk ...
pnpm ceremony drain                      # the only command that sends real email
```

`preflight` exits 0 only when every check passed. `drain` exits 1 if any row failed to send.

Environment (design spec section 10). `WARRANT_CEREMONY=1` is the switch; with it set and anything
else wrong, the process refuses to start rather than falling back to the demo runtime.

| Variable | Notes |
|---|---|
| `WARRANT_CEREMONY` | `1` and nothing else |
| `WARRANT_PRIVATE_KEY_HEX` | 64 hex chars. The published demo key is refused by name |
| `WARRANT_LEDGER_DATABASE_URL` | the **app role**: INSERT and SELECT only, and not the table owner |
| `WARRANT_LEDGER_ADMIN_DATABASE_URL` | DDL only, used by the schema step, never at runtime |
| `WARRANT_LEDGER_APP_ROLE` | plain SQL identifier; the role the guards are applied to |
| `GATEWERK_BASE_URL` · `GATEWERK_API_KEY` · `GATEWERK_WEBHOOK_SECRET` | secret is 16 chars minimum |
| `GATEWERK_TEMPLATE_SLUG` | **required, no default** (W-20). The default was `warrant-outbound-email`, the last domain word in a domain-blind package. Only the caller knows which Gatewerk template renders its review |
| `PUBLIC_BASE_URL` | must be https, except localhost. The callback URL is derived from it |
| `SMTP_HOST` · `_PORT` · `_USER` · `SMTP_PASSWORD` · `WARRANT_CEREMONY_FROM` | |
| `OPENAI_API_KEY` · `WARRANT_CEREMONY_MODEL` | |
| `WARRANT_CEREMONY_ALLOWED_RECIPIENTS` | comma separated. **No default. Empty is an error, never "anyone"** |

The recipient allowlist is enforced at the send boundary rather than in the policy document, because
changing the GTM policy would break golden parity. The send boundary is the last gate before a real
inbox, which is the one that matters for this risk; a refusal there is recorded as
`action.outcome{status:'failed'}` and the spent nonce is never retried.

Deployment also needs the Coolify proxy to forward **both** `/eve/` and `/.well-known/workflow/`.
Dropping the second makes every parked run stall silently, which is the failure that would make a
ceremony look inexplicably broken.
