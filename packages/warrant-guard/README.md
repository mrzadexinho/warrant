# @idriszade/warrant-guard

The enforcement seam. One guard, many actuators: verify, parse, recompute `paramsHash`, compare,
spend the nonce, act, record. Vendor-blind by construction.

Every path to a side effect in warrant runs the same sequence, in this order: parse and validate →
verify the warrant → recompute the params hash → compare it to the signed one → spend the nonce →
run the effect → record the outcome. This package is where that sequence lives exactly once, so a
fix applied here reaches every actuator instead of drifting between copies.

## Entry points

`guardedExecute(warrant, rawParams, schema, deps, effect)`: runs the full sequence and returns the
effect's own result, or a typed refusal if any step before it fails.

```ts
import { guardedExecute } from '@idriszade/warrant-guard';

const result = await guardedExecute(
  warrant,
  rawParams,
  EmailParamsSchema,
  { publicKeyHex, ledger, now: () => new Date(), outcomeStatus: 'sent' },
  async (params) => {
    // the actuator's own effect; params are validated and stripped
    return ok({ messageId: '...' });
  },
);
```

`verifyAuthorizedParams(warrant, finalParams, deps)`: the security core on its own, shared by
`guardedExecute` and the two other call sites (a governed drainer, a resume path) whose
surrounding shape differs. Checks signature, expiry, run identity, and the params hash, in that
locked order.

```ts
import { verifyAuthorizedParams } from '@idriszade/warrant-guard';

const authority = verifyAuthorizedParams(warrant, finalParams, {
  publicKeyHex, now: () => new Date(), expectedRunId: runId,
});
if (authority.error) throw new Error(authority.error.message);
```

## What it deliberately does not do

- **No knowledge of what the effect does or who it talks to.** The actuator owns its schema and
  its effect closure; this package owns everything between them. `tests/vendor-blind.test.ts`
  scans this directory's source, comments included, for any vendor, transport, or domain word.
- **No unspent nonce on failure.** The nonce is spent before the effect runs. If the effect fails,
  the nonce is burned and the warrant cannot be retried, because a burned nonce with no side
  effect is safer than a reusable warrant retried into a double-send.
- **No unrecorded effect.** A thrown effect is caught and recorded as `effect_threw`, never left
  to escape as an unrecorded side effect with a spent nonce.
- **No second guard.** A duplicate actuator is fine; a duplicate guard is a vulnerability, which
  is the reason this logic lives in its own package rather than beside each actuator.

## Tests

```bash
pnpm --filter "@idriszade/warrant-guard" test
```
