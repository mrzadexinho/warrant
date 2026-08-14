# A human-attested run, reproducible on one machine

This guide walks you through the full thesis with nothing but Docker and Node: an agent
proposes an action, policy routes it to a person, a real human approves it in a review UI
running on your machine, and warrant mints authority from that attested decision, executes
under guard, and hands you a verified hash chain of the whole journey.

Nothing here is simulated on the decision path. The review station is
[Gatewerk](https://github.com/gatewerk/gatewerk), the open source review layer, running from
its own published quickstart. The reviewer is you.

## What this proves, and what it does not

Proves:

- Policy reached the verdict `human` on its own, before any review existed.
- Warrant minted only after Gatewerk attested the decision came from an authenticated human
  reviewer session. The mint guard refuses any decision whose `last_action_by` does not carry
  a `reviewer:` prefix, so an API-key decision, however friendly its fields look, cannot mint.
- What executed is what was authorized: the guard re-verified the warrant, recomputed the
  params hash, and spent the single-use nonce before the actuator ran.
- The resulting ledger replays: every claim above is checked from the exported chain, not
  from this process's memory.

Does not prove:

- That the human was who they claimed. Warrant trusts the review station's session
  authentication; that trust boundary is stated, not hidden.
- Anything about a real delivery. The actuator here is an in-memory outbox. The repository
  separately ships a production certificate from a run whose send was real; see the README.

## Prerequisites

Docker, Node 20 or newer, pnpm 10 or newer. Two free ports: 3100 and 8880.

## 1. Run Gatewerk locally

```bash
git clone https://github.com/gatewerk/gatewerk.git
cd gatewerk
./scripts/quickstart.sh
```

This pulls the published images, applies migrations, seeds demo data, and waits until the API
is healthy. When it finishes:

- Dashboard: `http://localhost:8880`, login `admin@gatewerk.local` / `admin123` (you will be
  asked to set a new password on first login).
- API: `http://localhost:3100`.
- A seeded API key, printed once by the seed container. Recover it with:

```bash
docker compose logs gatewerk-seed
# look for a line containing gwk_<64 hex characters>
```

The seed also creates the `proposal-review` template this guide uses. It has no auto-approve
and no timeout, which is exactly what warrant's preflight would demand of it.

## 2. Run warrant's human demo

In a sibling directory:

```bash
git clone https://github.com/mrzadexinho/warrant.git
cd warrant
pnpm install
GATEWERK_API_KEY=gwk_...your seeded key... pnpm demo:human
```

The script proposes a cold outreach email, policy routes it to `human`, and a review appears
in Gatewerk. The script then waits, polling, and tells you so:

```
[2/7] Policy evaluates -> verdict: human. Review created in Gatewerk (gw_rev_...)
[3/7] Waiting for a HUMAN decision. Open the Gatewerk dashboard, find the pending
[3/7] review, and approve (or deny, or approve with an edit): http://localhost:8880
```

## 3. Decide, as a person

Open the dashboard, sign in, select the pending review. You will see exactly the fields the
agent proposed: To, Subject, Body. Approve it, or reject it. Rejection is a correct ending:
no warrant exists, nothing executes, and the refusal itself is in the ledger.

## 4. Read the proof

On approval the script completes within a few seconds:

```
[4/7] Human warrant minted from the attested decision (reviewId: gw_rev_...)
[5/7] Guard verified warrant + spent nonce -> executed against in-memory outbox
[6/7] Outcome recorded: 1 email in the outbox
[7/7] Chain verified (7 entries) -> wrote .../out/proof-human.md
```

Two artifacts land in `packages/warrant-eve-outbound-demo/out/`:

- `ledger-human.json`: the exported chain. Seven entries: `warrant.requested`,
  `policy.evaluated`, `review.submitted`, `review.decided` (carrying
  `decidedBy: admin@gatewerk.local`), `warrant.issued`, `action.executed`, `action.outcome`.
- `proof-human.md`: the replayed journey, rendered. The counts line shows `human: 1, auto: 0`.

## Why the script polls instead of receiving a webhook

Gatewerk validates a review's `callback_url` at creation and rejects localhost and private
addresses unconditionally (its SSRF guard), so a fully local run cannot receive the webhook.
That costs nothing here: the webhook is a doorbell, not the source of truth. The poll
re-fetches the decision from Gatewerk's API, and the mint guard applies the same human
attestation check either way. The callback URL the script sends is a syntactically valid
public placeholder that nothing answers.

## How this relates to the other two proofs in this repository

- `pnpm demo` is the same lifecycle with a simulated gate: offline, deterministic,
  byte-identical proof across runs. Good for CI and for reading the mechanics.
- The committed production certificate (`packages/warrant-eve-outbound-demo/ceremony/`) is a
  DSSE-signed run whose approval happened in a real Gatewerk and whose send was a real email.
  Verify it with one CLI command; the README shows how.
- This guide sits between the two: a real human decision, on your machine, in minutes.
