# @idriszade/warrant-verify

The verifier. It turns a ledger into an answer to one question: did this run stay inside the
rules, and can you check that without trusting whoever ran it.

This is the package that has to work for a skeptic. Its bin ships as a **self-contained esbuild
bundle** needing nothing but Node, no workspace, no install, no tsx. That is deliberate and
load-bearing: warrant's whole claim is that the proof is checkable by a third party who does not
trust the operator, and a verifier that required cloning a pnpm monorepo would make the claim
false.

## CLI

```
warrant-verify <ledger.json> [--json] [--dsse <out> --sign-key <hex>] [--verify-dsse <f> --key <hex>]
```

**The exit code is the verdict.** A run whose ledger records an action executing after a deny, or
executing with no warrant at all, exits **1**, in `--json` mode too. The report is still printed
either way, so a human sees the evidence and a CI gate (`warrant-verify ledger.json && deploy`)
also sees it. A flag given without its value is a usage error, not an absent flag.

## Library

| Export | What it does |
|---|---|
| `verifyChain(entries)` | Walks the hash chain: genesis link, contiguous sequence, each entry's stored hash matching its recomputed one, each `prevHash` matching the entry before it. |
| `replayRun(entries)` | Replays the ledger into a `RunReport`: per-warrant journeys, counts, and any authorization violations. |
| `renderProofMarkdown(report)` | Human-readable proof document. |
| `exportDsse`, `verifyDsse` | DSSE envelope over the run, signed and checked. |
| `buildStatement`, `parseStatement` | The in-toto statement wrapping the payload. |

## What the certificate does and does not prove

**Proves:** the chain is internally intact, and the recorded actions matched the policy recorded
alongside them, as of the moment it was signed.

**Does not prove:**

- **Whose key signed it.** The `keyid` is the raw public key hex. Anyone can check a signature;
  nobody learns whose it is. No certificate chain, no transparency log. Trust in the key is trust
  in the publisher, who must publish it out of band.
- **That the table was never rewritten.** `entryHash` is unkeyed SHA-256 over the entry body, so
  anyone with `UPDATE` or `DELETE` on the ledger table can recompute the entire chain and leave it
  internally consistent. Tamper evidence holds against casual modification and against anyone
  without database write access. It does not hold against the database credential itself. The DSSE
  signature is what makes a **snapshot** non-forgeable, and only as of signing time. Run the app
  under a role with `INSERT` and `SELECT` only, and sign promptly.
- **That anyone independent watched.** Runs are single-operator and self-attested.

## Design notes

**The verifier verifies.** `verifyDsse` checks the signature over the PAE-encoded payload **as
bytes**, not over decoded text, and the in-toto subject digest is bound to the payload it
describes. Both were once wrong in ways that let a tampered chain print as valid, which is why the
tests here are unusually blunt about what each one holds.

**A report with no `violations` field is not a clean report.** It predates violation checking, so
it renders as `AUTHORIZATION STATUS UNKNOWN` rather than clean. Absence of evidence is not
evidence of absence.

## Tests

```bash
pnpm --filter "@idriszade/warrant-verify" test
```

The package's `test` script runs `build` first, on purpose: the exit code of the **built bin** is
what a third party's shell reads, so the CLI tests drive the bundle rather than the source.
Running vitest directly would measure a stale `dist/cli.js`.
