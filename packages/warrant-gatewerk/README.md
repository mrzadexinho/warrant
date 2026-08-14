# @idriszade/warrant-gatewerk

The `Gate` port: how a review reaches a human. Real adapter for
[Gatewerk](https://github.com/gatewerk/gatewerk) plus a deterministic `SimGate`.

`requestAuthority` stops at a `human` verdict and hands the caller a decision it is not entitled
to make. `Gate` is the two-call interface across which that decision leaves warrant and comes
back: submit a review, later fetch what a human decided. Full contract:
[`docs/contracts/gate.md`](../../docs/contracts/gate.md).

## Entry points

`GatewerkGate`: the real adapter, backed by Gatewerk's HTTP API.

```ts
import { GatewerkGate } from '@idriszade/warrant-gatewerk';

const gate = new GatewerkGate({ baseUrl, apiKey, templateSlug, webhookSecret });
const submitted = await gate.submit({ requestId, runId, title, content, metadata });
const decision = await gate.fetchDecision(submitted.data.reviewId);
```

`SimGate`: a deterministic stand-in for tests and offline demos, driven by a script of
`'approve' | 'edit' | 'reject'` entries.

```ts
import { SimGate } from '@idriszade/warrant-gatewerk';

const gate = new SimGate(['edit'], {
  editContent: (content) => ({ ...content, body: `${content['body']}\n[edited]` }),
});
```

`verifyGatewerkWebhook(req, secret)`: checks an inbound webhook's signature. Treat the webhook as
a doorbell, not a decision: it only says "go look", and the actual decision is always re-fetched
through `fetchDecision`.

## What it deliberately does not do

- **No shape for `ReviewContent`.** It is `Record<string, unknown>` on purpose. Human decision
  content is domain-shaped and belongs to Gatewerk's template, not to this adapter; a concrete
  type here would be a compile-time claim about a value that only gets validated at the
  boundary. Consumers shape-guard it themselves.
- **No invented edits in `SimGate`.** What a reviewer edits is domain knowledge this package does
  not have. A script containing `'edit'` with no `editContent` supplied throws at construction,
  not several awaits later inside the code under test.
- **No trust in an unattested decision.** `ReviewDecision.decidedBy` is required on every
  non-pending outcome; a decision without one is not a `ReviewDecision` this package will hand
  back.

## Tests

```bash
pnpm --filter "@idriszade/warrant-gatewerk" test
```
