# @idriszade/warrant-eve-outbound-demo

The ceremony, a real certificate-producing governed run, and the offline demo for the warrant
stack. One package, two distinct purposes.

**The ceremony** is a live run against real infrastructure: a real Gatewerk review, a real human
decision, a real SMTP send, and a DSSE-signed certificate a third party can verify. It exists to
produce evidence, not to demonstrate the code path. What it actually proved, and what it does not,
is written up honestly in
[`ceremony/README.md`](ceremony/README.md), including two earlier runs that were approved and
never executed.

**The offline demo** is packaging around the same public APIs the end-to-end test drives:
`buildDeps`/`buildSendEmailTool`, `MemoryLedger`, `SimGate`, `resumeByPoll`, `exportLedgerJson`,
`verifyChain`, `replayRun`, `renderProofMarkdown`. It walks one complete warrant lifecycle end to
end with a fixed clock and id generator, so the run and the proof it writes do not depend on when
or how many times it is invoked.

```bash
pnpm demo
```

No network, no database, no configuration. It runs propose → policy reaches `human` → a simulated
reviewer approves **with an edit** → mint → guard verifies and spends the nonce → execute →
outcome, then verifies its own ledger chain and writes `out/proof.md`.

## Entry points

`buildDeps()` / `buildSendEmailTool(deps)`: build the demo's governed dependencies and the eve
tool wrapping `executeEmailQueue`, both reused by the demo and by the e2e test.

```ts
import { buildDeps, buildSendEmailTool } from '@idriszade/warrant-eve-outbound-demo';
```

`buildCeremonyRuntime(config)`: the ceremony's own dependency wiring, gated by
`isCeremonyEnabled()` and `loadCeremonyConfig()`, which refuse to start with `WARRANT_CEREMONY=1`
set and anything else misconfigured rather than silently falling back to the demo runtime.

`runCeremonyPreflight(deps)`: checks a live database is genuinely append-only, and that the
configured Gatewerk template is not auto-approving, before the ceremony is allowed to run.

## What it deliberately does not do

- **No shared config between ceremony and demo.** The ceremony refuses to start on any
  misconfiguration; the demo needs none to run at all. There is no path where one silently
  substitutes for the other.
- **No trust in the live table without proof.** The ceremony runs its own append-only assertion
  against the real database before doing anything else, using the same primitive
  `warrant-ledger` uses for provisioning.
- **No send outside the allowlist.** The ceremony's SMTP sender refuses any recipient not on
  `WARRANT_CEREMONY_ALLOWED_RECIPIENTS`, with no default; an empty allowlist is an error, never
  "anyone".

## Tests

```bash
pnpm --filter "@idriszade/warrant-eve-outbound-demo" test
```
