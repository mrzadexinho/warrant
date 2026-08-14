# Security Policy

Warrant is a governance layer: its whole purpose is to be the trustworthy part of an agent
system. Security reports are treated accordingly.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability"). You will get an
acknowledgment within 72 hours.

If the report concerns the integrity of the signed certificate format, the ledger's append-only
guarantees, nonce handling, or `canonicalJson`, please say so explicitly: those are the
load-bearing guarantees and jump the queue.

## Scope

In scope: everything under `packages/`, the SQL applied by `provision:ledger`, and the claims
made in `docs/warrant-kernel-invariants.md`. A documented guarantee that does not hold is a
vulnerability here, even if no conventional exploit exists.

Out of scope: the demo's simulated gate behaving as documented (it is a test double), and
vulnerabilities in third-party agent runtimes that adapters connect to.

## What this project already states about its own limits

The ceremony README
([`packages/warrant-eve-outbound-demo/ceremony/README.md`](packages/warrant-eve-outbound-demo/ceremony/README.md))
documents the known trust limits: the certificate key is self-asserted, a hash chain does not
survive an attacker with table-owner database access, and the residual double-send window in the
drainer. Reports that sharpen or falsify those statements are welcome.

## Supported versions

Pre-1.0: only the latest commit on the default branch is supported.
