# Error codes

Every public function in warrant that can fail returns a `Result<T, WarrantError>` rather than
throwing. `WarrantError` has three fields: `type` (`validation | integrity | transient |
permanent`), `code` (a stable, specific string), and `message` (free text, often carrying a
wrapped cause). `type` says what kind of fault it is and therefore what a caller should do about
it; `code` says which fault, for callers that need to branch on the specific one.

This page lists every `code` a public API in this repo can return, grouped by `type`, derived by
reading each site that constructs a `WarrantError`. A few packages (`warrant-eve`'s drainer) also
return operational status codes that are not `WarrantError` instances; those are listed separately
at the bottom, not mixed into the tables below.

## validation

Structural or input faults. The request, the params, the config, or the document itself is wrong.
Retrying the same call with the same input never helps.

| Code | Meaning | Source |
|---|---|---|
| `cannot_issue_on_deny` | `issueWarrant` was called against a `deny` verdict; a deny can never mint a warrant. | `warrant-core/src/issue.ts:22` |
| `noncanonical_params` | The params handed to `issueWarrant` could not be canonicalized. | `warrant-core/src/issue.ts:50` |
| `malformed_warrant` | A warrant fails schema validation: unknown keys, wrong shape, or bad field types. | `warrant-core/src/issue.ts:70,83` |
| `warrant_expired` | The warrant's `expiresAt` has already passed. | `warrant-core/src/issue.ts:74` |
| `policy_parse_error` | The policy YAML failed to parse. | `warrant-policy/src/load.ts:17` |
| `policy_schema_invalid` | The parsed policy document fails schema validation or an internal consistency check (e.g. a cap references an undeclared action kind). | `warrant-policy/src/load.ts:25,48` |
| `invalid_params` | Raw params failed the actuator's own Zod schema inside `guardedExecute`. | `warrant-guard/src/guarded-execute.ts:74` |
| `context_noncanonical` | `request.context` could not be canonicalized before hashing. | `warrant-authorize/src/request-authority.ts:138` |
| `issue_failed` | `issueWarrant` itself returned an error while minting. Reused on the human resume path when re-issuing against the final, possibly edited, content. | `warrant-authorize/src/request-authority.ts:196`; `warrant-eve/src/resume-issue.ts:137` |
| `invalid_identifier` | A SQL identifier (table or role name) fails the plain-identifier pattern. | `warrant-ledger/src/append-only.ts:59`; `warrant-ledger/src/assert-append-only.ts:71`; `warrant-eve/src/runtime-grants.ts:42` |
| `provision_env_invalid` | The ledger provisioning CLI's environment variables fail validation. | `warrant-ledger/src/provision-cli.ts:81` |
| `preflight_template_list_paged` | Gatewerk's template list response is paginated and the preflight only ever reads page one; refuses rather than trust a partial list. | `warrant-gatewerk/src/preflight.ts:121` |
| `preflight_template_missing` | No Gatewerk template matches the configured slug. | `warrant-gatewerk/src/preflight.ts:133` |
| `preflight_template_indeterminate` | The matched template's `auto_approve` or `id` field is not a usable value. | `warrant-gatewerk/src/preflight.ts:178,187` |
| `unrecognized_status` | A Gatewerk review response is not a recognizable shape. | `warrant-gatewerk/src/decision.ts:89,114` |
| `edited_no_content` | A decision of `edited` carries no `editedContent`. | `warrant-gatewerk/src/decision.ts:185`; `warrant-eve/src/resume.ts` (step 6) |
| `unrecognized_decision` | The decision value does not match the known approved/rejected/edited vocabulary. | `warrant-gatewerk/src/decision.ts:191` |
| `gatewerk_missing_review_id` | Gatewerk's submit response carries no usable review id. | `warrant-gatewerk/src/gatewerk-gate.ts:71` |
| `malformed_review_content` | The review's final content fails the actuator's own shape guard during human-path resume. | `warrant-eve/src/resume-issue.ts:101` |
| `policy_denied_on_final` | Re-evaluating policy against the human-edited content now returns `deny`. A legitimate re-check failing, not a bug. | `warrant-eve/src/resume-issue.ts:118` |
| `review_not_found` | No `review.submitted` ledger entry exists for the given `reviewId`. | `warrant-eve/src/resume.ts` |
| `missing_provenance` | A required correlation field is absent from the ledger: the review's `requestId`, the original request's `context`, or a matching `policy.evaluated` entry with `path: 'human'`. | `warrant-eve/src/resume.ts` (4 sites) |
| `human_attestation_missing` | The `Gate` returned a decision with no `decidedBy`. | `warrant-eve/src/resume.ts` |
| `ceremony_config_invalid` | The ceremony's environment configuration fails validation. | `warrant-eve-outbound-demo/src/config.ts:182` |
| `smtp_params_invalid` | Email params fail the SMTP sender's own schema. | `warrant-eve-outbound-demo/src/smtp-sender.ts:116` |
| `recipient_not_allowed` | The recipient is not on the ceremony's configured allowlist. | `warrant-eve-outbound-demo/src/smtp-sender.ts:128` |
| `unsafe_warrant_id` | `warrant.id` contains characters unsafe for a filename, or the resolved outbox path escapes `outboxDir`. | `warrant-pack-gtm/src/executor.ts:48,60` |
| `noncanonical_input` | A trajectory leaf could not be canonicalized while building the Merkle tree. | `warrant-verify/src/trajectory.ts` |
| `trajectory_no_leaves` | A trajectory attestation was built with an empty leaf set. | `warrant-verify/src/trajectory.ts` |
| `trajectory_leaf_malformed` | A trajectory leaf at a given index is not a valid leaf shape. | `warrant-verify/src/trajectory.ts` |
| `trajectory_payload_malformed` | The `trajectory.attested` payload fails schema validation. | `warrant-verify/src/trajectory.ts` |

## integrity

Something that should be internally consistent is not: a signature, a hash, a chain link, or a
database guarantee has been violated or could not be confirmed. Retrying the same call never
helps; these need investigation, not a retry loop.

| Code | Meaning | Source |
|---|---|---|
| `invalid_signature` | The warrant's Ed25519 signature does not match its contents. | `warrant-core/src/issue.ts:79` |
| `run_mismatch` | The warrant's signed `runId` does not match the run the caller is acting in. | `warrant-guard/src/verify-authorized-params.ts` |
| `params_noncanonical` | `paramsHash` computation threw on the final params. A structural fault in the caller's own data, not an adversarial signal. | `warrant-guard/src/verify-authorized-params.ts` |
| `params_mismatch` | The recomputed params hash differs from the one signed into the warrant: the bytes changed after authorization. The single most alarming code this package returns. | `warrant-guard/src/verify-authorized-params.ts` |
| `nonce_spent` | The warrant's nonce has already been spent; it cannot be replayed. | `warrant-ledger/src/memory.ts`; `warrant-ledger/src/postgres.ts` |
| `duplicate_review_claim` | A competing claim already exists for this `reviewRef` (a concurrent resume won the race). | `warrant-ledger/src/memory.ts`; `warrant-ledger/src/postgres.ts` |
| `noncanonical_payload` | A ledger entry's payload could not be canonicalized before hashing. | `warrant-ledger/src/memory.ts`; `warrant-ledger/src/postgres.ts` |
| `append_only_unverified` | The privileges query confirming append-only status could not be read or returned no row. Treated as a failure, not a pass. | `warrant-ledger/src/append-only.ts` |
| `append_only_not_enforced` | The connected role still retains `UPDATE`, `DELETE`, or `TRUNCATE`, or lacks `INSERT`/`SELECT`. | `warrant-ledger/src/append-only.ts` |
| `app_role_mismatch` | The role connected after provisioning does not match the intended app role. | `warrant-ledger/src/provision.ts` |
| `ledger_table_missing` | `assertLedgerAppendOnly` cannot find the named ledger table. | `warrant-ledger/src/assert-append-only.ts` |
| `ledger_role_owns_table` | The runtime role owns the ledger table; an owner can drop the guarding triggers and is not bound by `REVOKE`. | `warrant-ledger/src/assert-append-only.ts` |
| `ledger_role_cannot_append` | The runtime role lacks `INSERT` or `SELECT` on the ledger table. | `warrant-ledger/src/assert-append-only.ts` |
| `ledger_role_can_update` / `ledger_role_can_delete` / `ledger_role_can_truncate` | The runtime role still holds a privilege the append-only guarantee requires revoked. | `warrant-ledger/src/assert-append-only.ts` |
| `ledger_row_trigger_missing` / `ledger_truncate_trigger_missing` | The guarding trigger is absent or disabled on the ledger table. | `warrant-ledger/src/assert-append-only.ts` |
| `preflight_template_ambiguous` | More than one Gatewerk template matches the configured slug. | `warrant-gatewerk/src/preflight.ts` |
| `preflight_template_auto_approve` / `preflight_template_timeout_auto_approve` | The configured template would auto-approve reviews (directly, or via a timeout default); the preflight refuses to run against it. | `warrant-gatewerk/src/preflight.ts` |
| `runtime_grants_not_effective` | Applied runtime grants do not verify as effective once queried back. | `warrant-eve/src/runtime-grants.ts` |
| `runtime_grants_unverified` | The query verifying runtime grants itself failed. | `warrant-eve/src/runtime-grants.ts` |
| `paramshash_mismatch` | The defense-in-depth cross-check on the human resume path finds the newly issued warrant's `paramsHash` does not match the authorized content. | `warrant-eve/src/resume-issue.ts` |
| `chain_broken` | The ledger's hash chain does not verify. | `warrant-eve/src/resume.ts`; `warrant-verify/src/chain.ts` |
| `park_correlation_mismatch` | The park record's `callId` does not match the ledger's `requestId` for the same review. | `warrant-eve/src/resume.ts` |
| `signature_invalid` | A DSSE envelope or in-toto statement signature does not verify. | `warrant-verify/src/dsse.ts`; `warrant-verify/src/intoto.ts` |

## transient

The operation could not complete this time, usually because of a network, database, or process
fault, and not because the input or the system's state is wrong. Retrying can help, though a few
entries below carry caveats about *what* to retry.

| Code | Meaning | Retry note | Source |
|---|---|---|---|
| `ledger_error` | A ledger append failed inside `requestAuthority`. The code stays fixed, but `type` on this error carries the wrapped cause's own type forward, so the effective type is whatever the underlying ledger failure was (commonly `transient`, sometimes `integrity` for `noncanonical_payload`). Read the message for the wrapped cause. | Depends on the cause; a `db_error` cause is worth retrying, a `noncanonical_payload` cause is not. | `warrant-authorize/src/request-authority.ts` |
| `outcome_append_failed` | The actuator's effect already succeeded, but recording `action.outcome` failed. | Yes, retry recording the outcome. Do not retry the effect: the nonce is spent and the side effect already happened. | `warrant-guard/src/guarded-execute.ts` |
| `append_only_apply_failed` | Applying the append-only guards (triggers, grants) failed, usually a connection or transaction fault. | Yes. | `warrant-ledger/src/append-only.ts` |
| `db_error` | A Postgres operation failed. | Yes. | `warrant-ledger/src/postgres.ts`; `warrant-eve/src/park-store-pg.ts`; `warrant-eve/src/outbox-pg.ts` |
| `ensure_table_failed` | The ledger table creation/ensure step failed. | Yes. | `warrant-ledger/src/provision.ts` |
| `ledger_probe_failed` | The append-only privilege probe query itself failed. | Yes. | `warrant-ledger/src/assert-append-only.ts` |
| `gate_unreachable` | A transport-level failure reaching Gatewerk: the request never got a response. Distinct from `gatewerk_api_error` below, which means Gatewerk *did* respond, just not usefully. | Yes. | `warrant-gatewerk/src/preflight.ts`; `warrant-gatewerk/src/gatewerk-gate.ts` |
| `gatewerk_api_error` | Gatewerk responded, but with a non-OK status or a body this adapter cannot use. The HTTP status, when known, rides in the message. | Maybe, depends on the status carried in the message; a 5xx is worth retrying, a 4xx usually is not. | `warrant-gatewerk/src/preflight.ts`; `warrant-gatewerk/src/gatewerk-gate.ts`; `warrant-gatewerk/src/sim-gate.ts` (unknown `reviewId`) |
| `outbox_write_failed` | Writing the queued email to the local outbox file failed. | Yes. | `warrant-pack-gtm/src/executor.ts` |
| `export_failed` | Exporting the ledger to JSON for `warrant-verify` failed. | Yes. | `warrant-eve/src/export.ts` |
| `runtime_grants_failed` | Applying runtime grants failed, a connection or transaction fault. | Yes. | `warrant-eve/src/runtime-grants.ts` |
| `ledger_append_error` / `ledger_read_error` | A ledger append or read failed during resume. | Yes. | `warrant-eve/src/resume.ts` |
| `resume_internal_error` | `resumeByPoll` caught an unexpected exception, or hit a state its own invariants say is unreachable. | Yes for a caught exception; an unreachable-state case needs investigation, not a retry loop. | `warrant-eve/src/resume.ts` |
| `park_read_error` | Reading the park store failed. | Yes. | `warrant-eve/src/resume.ts` |
| `drainer_lock_error` | Acquiring the drainer's advisory lock threw. | Yes. | `warrant-eve/src/drainer.ts` |
| `drainer_internal_error` | `drainOutbox` caught an unexpected exception. | Yes. | `warrant-eve/src/drainer.ts` |
| `ceremony_schema_failed` | Ensuring the ceremony's database schema (tables) failed. | Yes. | `warrant-eve-outbound-demo/src/ceremony-deps.ts` |
| `park_observer_internal_error` | Catch-all for any unexpected exception in the park observer. | Yes. | `warrant-eve-outbound-demo/src/park-observer.ts` |
| `smtp_no_message_id` | The SMTP transport accepted the send but returned no `messageId`. | Maybe. The message may already be in flight; check the recipient's inbox before resending. | `warrant-eve-outbound-demo/src/smtp-sender.ts` |
| `smtp_send_failed` | The SMTP transport threw. | Maybe. Whether the message actually left is not always knowable from this error alone; see the ceremony README's note on the residual double-send window. | `warrant-eve-outbound-demo/src/smtp-sender.ts` |

## permanent

A fault that will not resolve itself on retry: a bug, a misbehaving dependency, or a definitive
refusal reported by something warrant called.

| Code | Meaning | Source |
|---|---|---|
| `authorize_internal_error` | `requestAuthority` caught an unexpected exception. The whole function is wrapped so it can fail as a value instead of throwing; seeing this code means that wrapping caught something unplanned. | `warrant-authorize/src/request-authority.ts` |
| `effect_threw` | The actuator's effect closure threw instead of returning a `Result`. The nonce is already spent by the time this is recorded. | `warrant-guard/src/guarded-execute.ts` |
| `tool_reported_error` | The wrapped MCP tool handler returned `isError: true`. This is the tool's own reported failure, carried through unchanged rather than relabeled. | `warrant-mcp/src/govern-tool.ts` |

## Codes easy to confuse

**`params_mismatch` vs `params_noncanonical`** (`warrant-guard`). Both are `integrity`, but they
are different facts. `params_noncanonical` means the bytes could not be canonicalized at all, a
structural fault in the caller's own params with no adversary implied. `params_mismatch` means the
bytes canonicalized fine and hashed to something other than what was signed, meaning somebody
changed the payload after it was authorized. Only one of these is an alarm.

**`gate_unreachable` vs `gatewerk_api_error`** (`warrant-gatewerk`). `gate_unreachable` is a
transport outage: the request never got a response. `gatewerk_api_error` means Gatewerk answered
promptly and either refused or returned something unusable. Collapsing the two turns a definite
refusal into a network blip, or a network blip into a definite refusal; a caller that retries an
attestation failure under the wrong label would retry forever.

**`malformed_warrant` vs `invalid_signature`** (`warrant-core`). A malformed warrant failed schema
validation before any cryptography ran: wrong shape or an extra key. An invalid signature means
the shape was fine but the signature does not match. The first points at corruption or a version
mismatch; the second points at tampering or a wrong key. Same distinction is what `verifyWarrant`
exists to preserve.

**`append_only_unverified` vs `append_only_not_enforced`** (`warrant-ledger`). Unverified means the
check itself could not run or could not read a result: the property is simply unknown. Not
enforced means the check ran and found the role still holds a privilege it should not. Both are
`integrity` and both refuse to proceed, but only one names a specific held privilege.

## Non-`WarrantError` operational codes

`warrant-eve/src/drainer.ts`'s `DrainResult` carries its own `code: string` on `failed` and
`skipped` outcomes. These are not `WarrantError` instances (no `type` field) and are not part of
the taxonomy above; they describe the drainer's own per-row bookkeeping.

| Code | Status | Meaning |
|---|---|---|
| `ledger_read_error` | skipped | The run could not be read from the ledger. Unread is not unauthorized, so the row is skipped, not failed. |
| `warrant_missing` | skipped | Zero or more than one `warrant.issued` entry exists for this row; neither case says which warrant authorized it. |
| `warrant_run_mismatch`, `params_noncanonical`, `params_mismatch`, or `warrant_<code>` | failed | `verifyAuthorizedParams` refused; the specific code names which check failed. |
| `not_executed` | failed | No `action.executed` entry exists for this row; `execute` never spent the nonce for it. |
| `executed_warrant_mismatch` | failed | An `action.executed` entry exists but names a different warrant. |
| `already_terminal` | skipped | A terminal outcome (`sent` or `failed`) is already recorded; never retried. |
| `send_threw` | failed | The sender threw rather than returning a `Result`. |
| `send_<code>` | failed | The sender returned a typed error; `<code>` is that error's own code. |
| `outcome_append_error` | failed | The send happened but recording `action.outcome` failed. The row is deliberately kept, not retired, so this state stays visible; see the ceremony README's residual double-send window. |
| `drainer_internal_error` | failed | `drainRow` threw unexpectedly for this row. |
