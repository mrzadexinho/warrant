# OWASP Top 10 for Agentic Applications 2026 (ASI): Warrant v0.1 coverage matrix

> HONEST status: mark claims only where the codebase contains verifiable implementation.

| ASI ID | Requirement summary | Warrant v0.1 component | Status |
|---|---|---|---|
| ASI01 | Agent actions require explicit authorization before execution | `issueWarrant` + `executeEmailQueue` verify-before-write order | **COVERED**: warrant must exist and be chain-spent before outbox write |
| ASI02 | Authorization decisions are auditable and non-repudiable | Hash-chained `LedgerEntry` per event; `verifyChain` + DSSE export | **COVERED**: every event is tamper-evident; DSSE envelope is externally verifiable |
| ASI03 | Least-privilege: agents cannot exceed declared policy scope | `evaluate()` deny-dominant; default-deny if no stakes rule fires | **COVERED**: policy evaluator is pure, deny-first; `defaultGtmPolicy` enforces caps |
| ASI04 | Human-in-the-loop for high-stakes actions | `Gate` interface; `SimGate` + `GatewerkGate`; `human` verdict path | **COVERED** (sim); live `GatewerkGate` requires `GATEWERK_API_KEY` at ceremony |
| ASI05 | Warrants / tokens are single-use | `append` nonce-spent check in `MemoryLedger` / `PostgresLedger` | **COVERED**: `action.executed` with duplicate nonce → `err integrity 'nonce_spent'` |
| ASI06 | Credentials and secrets not in agent context | `process.env` reads only in CLI entrypoint; domain logic injected | **COVERED**: pillar 7; no env reads inside policy/ledger/gatewerk classes |
| ASI07 | Memory/context poisoning prevention | Not implemented (no vector store or RAG in v0.1 scope) | **NOT COVERED in v0.1**: deferred; future `MemoryGuard` layer |
| ASI08 | Sandboxing / execution isolation for tool calls | Not implemented (Node process, no container/seccomp boundary) | **NOT COVERED in v0.1**: deferred; operator deployment concern |
| ASI09 | Supply-chain integrity of agent dependencies | `@noble/ed25519` + `@noble/hashes` declared (caret-ranged); `private: true` packages | **PARTIAL**: deps declared; no SLSA provenance or lockfile signing in v0.1 |
| ASI10 | Prompt injection resistance | Not implemented (warrant policy is declarative YAML, not LLM-rendered; LLMs never issue verdicts, pillar 5) | **PARTIAL**: LLMs cannot override policy; but no prompt-injection scanning of signal content |

### Notes

- **NOT COVERED** rows are honest gaps deferred per the sim-first constitution, not oversights.
- ASI09 PARTIAL: deps declared (caret-ranged); no SLSA Level 2+ provenance in v0.1.
- ASI10 PARTIAL: architecture is structurally resistant (YAML policy, no LLM verdicts), but signal
  content is not scanned for prompt injection in v0.1.
