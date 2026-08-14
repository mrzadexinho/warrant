# Philosophy

> An agent's authority should be provable, not asserted.

## The Belief

AI agents keep getting more capable, and the actions they carry keep getting more consequential.
We believe an agent acting in the world should be able to show, at any later moment and to any
skeptical party, that every action it took was inside rules a human set. Not a log that says so.
A proof that cannot say otherwise.

Warrant exists to make that practical: a gate that runs before the action, and a receipt that
survives after it.

Three commitments follow:

1. **The gate is code, not another AI.** Policy evaluation is a pure function over the request
   and the policy. No model in the loop means no prompt can talk it into yes, and the same input
   always produces the same verdict. That determinism is what makes verdicts replayable, and
   replay is what gives the certificate its value.
2. **The proof is mathematics, not a dashboard.** Decisions land in an append-only, hash-chained
   ledger and export as a DSSE-signed certificate. A third party verifies it with one file and
   Node. They do not have to trust the operator, the vendor, or us.
3. **Sovereign by construction.** Warrant is code you import, running inside your own systems.
   Policy and ledger never leave the operator's walls. There is no hosted service to trust and no
   phone-home to audit.

## What We Are

An in-process governance kernel for AI agents: TypeScript libraries that enforce policy at the
moment of action and produce portable cryptographic evidence. We provide the primitives for the
authorization seam (was this permitted) and the enforcement seam (did what executed stay inside
what was permitted).

## What We Are NOT

- Not an agent runtime (bring your own; adapters exist and more are welcome)
- Not a monitoring or observability tool (watching after the fact is a different job; we gate)
- Not a review UI (that is a human surface; Gatewerk and anything like it sit on the other side
  of our `Gate` port)
- Not a hosted service (code you import, never a dependency on our uptime)

We sit between your agent and its side effects. That's it.

## Design Principles

### 1. Deny by Default

Unmatched requests deny. Malformed input denies rather than throws. A rejected promise on an
approval path is a fail-open, and fail-open is the one failure mode a governance layer may never
have.

### 2. One Guard

Every path to a side effect runs the same sequence: verify the warrant, recompute the params
hash, compare, spend the nonce once, act. Duplicate actuators are fine. A duplicate guard is a
vulnerability, because two guards drift and the weaker one becomes the real policy.

### 3. One Definition of Identity

Exactly one `canonicalJson` implementation exists in the ecosystem. It defines what bytes mean,
so a second implementation is not a convenience, it is a fork of the truth: divergence would
invalidate every certificate ever issued.

### 4. The Ledger Is the System

Every other view is a projection. The ledger is append-and-verify only, and deliberately not a
query API, because an audit trail that doubles as an analytics store accumulates reasons to
loosen its guarantees.

### 5. What Executes Is What Was Authorized

The warrant binds the exact bytes of the action's params. The executor re-hashes and compares
before acting, so a reviewer's edit cannot be approved while the unedited version runs. This
binds every adapter, not just the guard.

### 6. Humans Decide the Irreversible

Policy routes consequential actions to a person, and a machine-made approval can never mint
authority: warrant refuses to mint from any review decision that does not carry the review
station's attestation of an authenticated human reviewer session. Making that attestation true
is the station's job; refusing to mint without it is warrant's, enforced in this codebase.
Agents carry the operational load. The decision, and the ownership that comes with it, stays
human.

### 7. Honest Claims Only

The certificate's own documentation states what it does not prove, and the shipped ledger
includes the failed runs beside the successful one. A governance product that oversells its
guarantees is worse than none, because it replaces caution with false confidence.
