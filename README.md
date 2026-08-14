# Warrant

[![ci](https://github.com/mrzadexinho/warrant/actions/workflows/ci.yml/badge.svg)](https://github.com/mrzadexinho/warrant/actions/workflows/ci.yml)

> The gate is code. The proof is mathematics.

**A governance layer for AI agents.** Warrant enforces a deterministic policy at the moment an
agent acts, and produces a signed, portable proof that the action stayed inside the rules. It runs
in-process, inside your own systems, on any TypeScript agent runtime.

Two properties carry the design:

- **The gate is code, not another AI.** Policy evaluation is a pure function over
  `(request, policy)`. There is no model in the loop, so it cannot be prompt-talked into yes.
- **The proof is mathematics, not a dashboard.** Every decision lands in an append-only,
  hash-chained ledger, exportable as a DSSE-signed certificate that a third party can verify
  without trusting the operator.

In plain terms: most tools tell you what your agent *did*, after the fact. Warrant stands between
the agent and the action, like a permission slip that has to be countersigned before anything
happens. The receipts book it keeps cannot be quietly rewritten.

## Verify a real certificate first

This repo ships the signed certificate of a production run from August 2026. An AI agent proposed
a real outbound email. Policy independently routed it to a human. A person approved it in a review
UI, a warrant was minted against that attestation, the guard verified and spent it, and the email
was actually sent. All 38 ledger entries are in the snapshot, including two earlier runs that were
approved and then never executed. Honesty is part of the proof.

```bash
pnpm install
pnpm --filter @idriszade/warrant-verify build
cd packages/warrant-eve-outbound-demo/ceremony
node ../../warrant-verify/dist/cli.js ledger.json \
  --verify-dsse certificate.dsse.json \
  --key f0959d2deec03d5bbd3291ec7df135bbd187af6c2cabe616d700a8d8349f7a44
```

Expected output: `DSSE valid, chain verified. Entries: 38`, exit 0. See
[`packages/warrant-eve-outbound-demo/ceremony/README.md`](packages/warrant-eve-outbound-demo/ceremony/README.md)
for what the run actually was, failed attempts included.

## Run the whole pipeline offline

```bash
pnpm demo
```

No network, no database, no configuration. It runs the full chain: propose, policy reaches
`human`, a simulated reviewer approves **with an edit**, mint, the guard verifies and spends the
nonce, execute, outcome. Then it verifies its own ledger chain and writes a proof summary to
`packages/warrant-eve-outbound-demo/out/proof.md`.

## Toolchain

Node 20 or newer and pnpm 10 or newer (see `engines` and `packageManager` in `package.json`).
Everything is TypeScript ESM. These are libraries you import, not a service you call.

## The packages

Kernel. Domain-blind, and the part that must not be duplicated:

| Package | Owns |
|---|---|
| `warrant-core` | The shared types (`ActionRequest`, `Warrant`), signing, and `canonicalJson`: the single definition of identity. Exactly one implementation exists, by design. |
| `warrant-policy` | `evaluate(request, policy)`. Pure, deterministic, deny-by-default. Malformed input denies rather than throws. |
| `warrant-ledger` | The append-only, hash-chained Postgres ledger. Append-and-verify only, deliberately not a query API. The append-only guarantee lives in SQL grants, not in application discipline. |
| `warrant-verify` | Independent replay of the chain, DSSE certificate export and verification, and the CLI used above. Its fold is deliberately a second implementation: a verifier that imports the producer's fold proves only that the producer agrees with itself. |
| `warrant-guard` | The enforcement seam: verify the warrant, recompute the params hash, compare, spend the nonce once, act. One guard, many actuators. A duplicate actuator is fine; a duplicate guard is a vulnerability. |
| `warrant-authorize` | The authorization seam: hash the context, record the request, evaluate, record the verdict. The ledger can then prove policy was consulted *before* authority existed. |

Adapters and demos:

| Package | Owns |
|---|---|
| `warrant-gatewerk` | The `Gate` port: how a review reaches a human. Ships a real adapter for Gatewerk (a human-oversight station, public release upcoming) and a deterministic `SimGate` for tests and the demo. Review content crosses as an opaque record; warrant carries it without looking inside. |
| `warrant-mcp` | Governs MCP tool calls. The tool's handler runs on the *authorized* params, never the caller's original input. |
| `warrant-eve` | Adapter for the eve agent runtime: park on `human`, wake on the decision, execute under the minted warrant. |
| `warrant-pack-gtm` | An opinionated policy pack for outbound GTM, as an example of the layer above the kernel. |
| `warrant-eve-outbound-demo` | The ceremony (the production run above) and the offline demo. |

## Honest claims

- **"Any TypeScript agent runtime"** is the current, accurate scope. The positioning aspiration is
  "any framework". A non-TS path (a WASM build of `warrant-core`, or a thin client to a local
  signer) has been sketched and not built. The constraint that binds any such path: exactly one
  `canonicalJson` implementation may exist, because it defines identity.
- The packages are not yet on npm. This repo is consumed by cloning, and
  `pnpm install && pnpm test` is the supported path.
- The certificate's trust limits are stated, not hidden. The signing key is self-asserted:
  anyone can check the signature, and trust in whose key it is comes from where the key is
  published, not from a certificate authority. A hash chain does not survive an attacker who
  owns the database table; the signed snapshot is the artifact, and the append-only grants are
  what keep the live table honest below that. The full statement, failed runs included:
  [`packages/warrant-eve-outbound-demo/ceremony/README.md`](packages/warrant-eve-outbound-demo/ceremony/README.md).
- The invariants that must survive any change are written down in
  [`docs/warrant-kernel-invariants.md`](docs/warrant-kernel-invariants.md). The contracts that
  cross a project boundary live in [`docs/contracts/`](docs/contracts/). How the guarantees are
  tested, including what the tests do not claim: [`docs/testing.md`](docs/testing.md).
- A simulated gate that runs past the end of its script defaults to approve. That is a sim-only
  convenience, documented in [`docs/contracts/gate.md`](docs/contracts/gate.md) §6.

## Philosophy

The beliefs behind the design are short and written down: [`philosophy.md`](philosophy.md).
Reporting a vulnerability: [`SECURITY.md`](SECURITY.md). Contributing:
[`CONTRIBUTING.md`](CONTRIBUTING.md). What ships when: [`CHANGELOG.md`](CHANGELOG.md).

## The system around it

Warrant is the middle of a three-part system: **Millwerk senses** (produces the
`ActionRequest`s), **Warrant authorizes**, **Gatewerk decides** (the human review surface).
Public releases of the other two follow this repo; links will land here when they do. Each is
independently useful. Together they are an operating loop for agents whose actions have
consequences.

## License

Apache-2.0. See [LICENSE](LICENSE).
