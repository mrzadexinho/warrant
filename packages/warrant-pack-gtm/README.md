# @idriszade/warrant-pack-gtm

Opinionated outbound-GTM policy pack: an example of the layer above the domain-blind kernel.

Everything below this package (core, policy, ledger, guard) is domain-blind by design. This
package is what a specific vertical looks like on top of that kernel: a bundled policy document
for outbound email, an actuator that queues a message to a local outbox, and an attestation helper
for when it was actually sent.

## Entry points

`defaultGtmPolicy()`: loads the bundled GTM policy YAML (protected audiences, daily caps, stakes
rules for outbound email) and returns it in the `{ doc, hash }` shape `evaluate` expects.

```ts
import { defaultGtmPolicy } from '@idriszade/warrant-pack-gtm';

const policy = defaultGtmPolicy();
```

`executeEmailQueue(warrant, params, deps)`: the actuator. Runs `guardedExecute` under
`EmailParamsSchema` and, once authorized, writes the message to a JSON file under `deps.outboxDir`
named by the warrant's own id.

```ts
import { executeEmailQueue, EmailParamsSchema } from '@idriszade/warrant-pack-gtm';

const result = await executeEmailQueue(warrant, { to, subject, body }, {
  ledger, publicKeyHex, outboxDir: './outbox', now: () => new Date(),
});
```

`markSent(opts)`: appends an `operator.attested` ledger entry recording that a queued message was
actually sent, once some downstream drainer confirms it.

```ts
import { markSent } from '@idriszade/warrant-pack-gtm';

await markSent({ runId, warrantId: warrant.id, operator, ledger, now: () => new Date() });
```

## What it deliberately does not do

- **No hashing or nonce logic of its own.** `executeEmailQueue` holds only the schema and the
  effect closure; everything between "is this warrant good for exactly these params" and
  "record what happened" is `guardedExecute`'s job, imported rather than reimplemented.
- **No path traversal.** `warrant.id` becomes a filename, so it is checked against a safe
  character set and the resolved path is confirmed to stay inside `outboxDir` before anything is
  written.
- **No YAML read from disk at runtime.** The default policy is inlined into the package source
  rather than read with `readFileSync`, because a relative asset does not survive some bundlers;
  a test guards the inlined copy against drifting from the source YAML.

## Tests

```bash
pnpm --filter "@idriszade/warrant-pack-gtm" test
```
