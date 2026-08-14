# Changelog

What changed and when it shipped. The clock starts at the first public release: earlier work is
carried by the repository itself (the code, the tests, the signed ceremony artifacts), not by
reconstructed entries nobody could have observed.

## v0.1.0 (date set on the day the repository goes public)

Warrant is public.

- The kernel: policy evaluation (pure, deny-by-default), the append-only hash-chained ledger,
  warrant issuance and verification, the enforcement guard, the authorization seam, and
  independent chain replay with DSSE certificate export.
- A real, verifiable production certificate ships in the tree: a governed run from August 2026
  in which a human approved an outbound email in a review UI and the send executed under a
  minted warrant. Verify it with one CLI command; the README shows how.
- A deterministic offline demo (`pnpm demo`) runs the whole chain with no infrastructure.
- Adapters: Gatewerk (human review), MCP (governed tool calls), the eve agent runtime, and an
  example GTM policy pack.
- CI proves build-on-clone and certificate verification on Linux, macOS, and Windows across
  Node 20, 22, and 24.
