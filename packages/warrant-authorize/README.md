# @idriszade/warrant-authorize

The authorization seam. One request path, many runtimes: record the request, evaluate, record the
evaluation with the context it saw, record the outcome. Runtime-blind by construction.

This is the half of the certificate that says an action was *permitted*; `warrant-guard` owns the
half that says an action *stayed inside what was permitted*. It takes an already-built
`ActionRequest` and hands back a verdict and, on the auto path, a warrant. It knows nothing about
the runtime that called it, what an approval callback is, or what a tool is. See
[`docs/contracts/adapter-authors-guide.md`](../../docs/contracts/adapter-authors-guide.md) §1 for
how this differs from `warrant-guard`.

## Entry points

`requestAuthority(request, deps)`: the whole sequence, wrapped so it can never throw. Every exit
is a value, because a rejected promise reads to some callers as a fail-open rather than a refusal.

```ts
import { requestAuthority } from '@idriszade/warrant-authorize';

const outcome = await requestAuthority(request, {
  policy, keys, ledger, now: () => new Date(), newId: () => randomUUID(), autoTtlMs: 5 * 60_000,
});
if (outcome.error) throw new Error(outcome.error.message);

// outcome.data.path is 'auto' | 'human' | 'deny'
if (outcome.data.path === 'auto') {
  const { warrant } = outcome.data; // ready to guardedExecute
}
```

## What it deliberately does not do

- **No review submission.** On the `human` path this returns the verdict and stops. Review
  content is domain-shaped, so the caller submits the review and appends `review.submitted`
  itself; pulling a `Gate` in here would drag domain knowledge into a primitive whose whole claim
  is that it has none.
- **No unrecorded refusal.** A `deny` verdict is a successful authorization decision, not an
  error, and it is written to the ledger before it is returned. A refusal that never got written
  down is treated as a failure, not a `deny`.
- **No unrecorded warrant.** A warrant is only ever handed back after `warrant.issued` is
  appended, because an actuator re-reads its authority from the ledger, and returning a warrant
  that never landed there would hand out a token nothing downstream can find.
- **No second copy of this sequence.** A duplicate adapter is fine; a second copy of "was policy
  ever consulted" is a second source of truth for the same fact, which is why this lives in its
  own package.

## Tests

```bash
pnpm --filter "@idriszade/warrant-authorize" test
```
