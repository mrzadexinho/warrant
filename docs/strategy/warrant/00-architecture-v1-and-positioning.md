# Warrant: Architecture v1 Roadmap & Positioning (north star)

> **Summary (read first):** The durable north star for warrant + its adapters. Warrant is a
> **governance LAYER for AI agents**: it ENFORCES a deterministic policy at the moment an agent
> acts, and PRODUCES a cryptographic, portable proof that the action stayed inside the rules, across
> ANY agent runtime, running entirely inside the operator's own systems. It is built as a **small
> kernel + a few ports + a widening ring of adapters** (NOT a feature list). **Architecture v1 is
> "done" when three things are true:** (1) the eve adapter is end-to-end real (Milestone B + a live
> proof run), (2) a second, very different adapter exists (MCP), (3) the ports are named + documented
> as the public contract. **Content generation (README + case study + narrative) comes AFTER v1** so
> every claim is already true. **Sections:** §1 What it concretely IS · §2 Growth model · §3
> Architecture v1 definition · §4 Pragmatic usage + adoption · §5 Positioning + the moat · §6 Path.
> The one line: *everyone else tells you what your agent did; warrant stops it in the moment and hands
> you a signed, portable proof it stayed inside the rules, on any framework, without your data leaving.*

---

## §1 What warrant concretely IS (metaphor → real artifact)

Everything is TypeScript npm packages (`@idriszade/warrant-*`) that run **in-process** inside the
operator's stack, next to their agent. Not a hosted service. Code you import. This is load-bearing
(sovereignty: policy + ledger never leave the operator's walls).

> **⚠️ OPEN and unreconciled.** The pitch three paragraphs up says **"on any framework"**, and the
> paragraph you just read says **everything is TypeScript, and that is load-bearing.** *Those two
> sentences have never been reconciled anywhere in this repository.* The adapter roadmap in §4
> (`eve → MCP → LangGraph → …`) is entirely JS/TS-ecosystem, and LangGraph's Python-first edition is
> indistinguishable in that list from LangGraph.js.
>
> **This is concrete rather than theoretical: Gatewerk already ships an `sdk-py`, and pursuit's
> job-search pipeline is 11k lines of Python.** Python-native agent runtimes are a large fraction of
> what *"any framework"* promises.
>
> **What is NOT the answer:** porting warrant to Python. Warrant's own duplication rule forbids a
> second `canonicalJson` implementation, because a second source of identity invalidates every
> certificate. **But that is a duplication rule, not a language rule**, and options that keep exactly
> one implementation have not been evaluated: a WASM build of `warrant-core`, or a thin client calling
> a local TypeScript signer.
>
> Until this is decided, the honest claim is **"any TypeScript agent runtime"**, and the pitch should
> either be narrowed or the bridge designed. Do not let a document repeat the unqualified version.

| Role (metaphor) | What it actually is | Package |
|---|---|---|
| **Rulebook (policy)** | A YAML file (version, `defaults: deny`, `protectedAudiences`, `caps`, `stakes` rules routing to auto/human/deny) + a pure deterministic `evaluate()` function. Config file + interpreter. | `warrant-policy` |
| **Notary (the warrant)** | A function `issueWarrant()` that outputs a **signed JSON object**: who, what, a SHA-256 fingerprint of the exact contents, a single-use nonce, an expiry, and an Ed25519 signature. A purpose-built, single-use, expiring, signed permit. | `warrant-core` |
| **Ledger** | An append-only, **hash-chained store**: in-memory array (dev) or a Postgres table `warrant_ledger` (prod), each row carrying the prior row's fingerprint so tampering breaks the chain. A queryable, tamper-evident table. | `warrant-ledger` |
| **Verifier** | A CLI (`warrant-verify`) + library (`verifyChain`, `replayRun`) that walks the chain, replays a run into a report, and emits a **DSSE-signed certificate** (in-toto-interop attestation format). A command you run / a function you call. | `warrant-verify` |
| **Human desk (gate)** | The bridge to Gatewerk (approve / edit / reject), behind a `Gate` interface. | `warrant-gatewerk` |
| **The wire (adapter)** | `withWarrant()` wraps a runtime's tool so the whole loop happens automatically around it. | `warrant-eve` (first) |

Reference agents that run the whole loop end-to-end: `warrant-agent-outbound` (Claude Agent SDK) and
`warrant-eve-outbound-demo` (Vercel eve). Both emit the SAME certificate, checked by the SAME verifier.

## §2 Growth model: kernel + ports + adapters (NOT a feature list)

Warrant grows like an operating system, not like a feature checklist. Hold this one picture:

- **Kernel (small, slow, must stay trustworthy):** the law and the proof, namely policy, notary, ledger,
  verifier. It changes rarely and only deepens deliberately.
- **Ports (few, stable contracts):** `Gate` (human desk), `Ledger` (audit store), and the
  **enforcement seam** (how a runtime's tool gets wrapped). A port is a fixed shape, nothing more.
- **Adapters (many, cheap, independent, parallel):** implementations that fill the ports. Gatewerk
  fills `Gate`; Postgres/Memory fill `Ledger`; `warrant-eve` fills the enforcement seam.

**Two axes moving at different speeds:**
- **Breadth grows FAST via adapters** (runtime adapters: eve → MCP → LangGraph → …; integration
  adapters: other desks, ledgers, proof formats). Cheap because every adapter reuses the kernel and
  emits the same proof. Each is a discrete, verifiable, portfolio-grade piece. Breadth without sprawl:
  ten adapters are still one architecture, one law, one proof.
- **Depth grows SLOW via modular components** (richer policy: budgets/delegation/per-tenant; heavier
  proof; new ledger backends). **Promotion discipline:** a capability earns its way into the kernel
  ONLY when 2+ adapters actually need it. Until then it lives at the edge.

The middle stays small and slow so it can stay trustworthy; the edge grows fast and wide because it
is cheap and safe to. **Refuse feature-list growth.** Bloat is what makes a governance product
un-trustworthy, and un-trustworthy is fatal here.

## §3 Architecture v1: the definition of "done"

v1 is NOT done at one adapter (one fit could be luck). It is done when the kernel + ports are proven
to be real interfaces, not eve-specific accidents. Three closing pieces:

**(a) The eve story is end-to-end real: "Milestone B."**
- Live `gatewerkReviewChannel` (`defineChannel` webhook receiving Gatewerk's decision →
  `agent.deliver({continuationToken, inputResponses})`), `capabilities.requestInput:true` wiring.
- Close the residual concurrent-resume TOCTOU with a **warrant-ledger UNIQUE index on (event,
  reviewId)** (currently fail-closed via execute's exactly-one guard; make it fail-closed at the store).
- Deploy one governed eve agent and do **the ceremony**: one real run that publishes a real,
  DSSE-signed certificate as the public artifact.

**(b) A second, very different adapter: MCP (`warrant-mcp`).**
- Wrap MCP tool calls with warrant. MCP is the widest socket in the ecosystem (Claude Desktop,
  Cursor, any MCP client), so one adapter governs a large slice at once, touching none of their code.
- Two genuinely different adapters is what turns "I integrated eve" into "I have a kernel + a port,
  and here is proof the pattern holds."

**(c) The ports are named + documented as the public contract.**
- Formalize `Gate`, `Ledger`, and the **enforcement seam** as stable, documented contracts (Policy +
  Signer stay kernel-internal). Write a short **adapter-author's guide** (how to add a new runtime).
- This is the step that makes warrant a LAYER instead of a one-off. After it, the next adapter is
  obviously a filling-in of a known shape.

When (a)+(b)+(c) hold, the true sentence is: *"warrant is a governance kernel with clean ports and a
growing ring of adapters, and here are two proofs it plugs into anything."* THAT is architecture v1.

## §4 Pragmatic usage + adoption

**The loop** (slots into an existing system; replaces nothing): **write policy → wrap the risky tools
→ run → audit.**
1. Write a short YAML rulebook once.
2. Wrap the one tool that touches the world: `withWarrant(send_email, …)`. Agent logic untouched.
3. Every action now flows through the gate automatically: policy → signed permit / human desk / deny
   → execute-only-with-a-valid-permit → every step written to `warrant_ledger`.
4. Run `warrant-verify` over the ledger anytime → a signed certificate for finance / compliance /
   regulator / counterparty.

**Adoption on-ramp (deliberately gentle):** start with the single highest-stakes tool (the one that
sends money/messages or changes records), wrap only that, point it at one Postgres table. Value from
the first tool; expand tool-by-tool at your own pace. Low commitment, immediate payoff.

**Reach:** enforcement sits at the **tool call**, the one universal thing every agent does regardless
of how it is built, so adapters carry it as wide as the ring grows. MCP is the highest-leverage next
socket.

## §5 Positioning: the gap only warrant fills

Four neighboring categories each do a piece; none do the thing:
- **Observability** (Langfuse, LangSmith, tracing): *watches*, does not stop; logs are mutable, trust-the-vendor.
- **Model guardrails** (NeMo, Llama Guard, prompt filters): police *model text*; fuzzy, prompt-talkable, know nothing of business rules or a ledger.
- **Framework-built-in HITL**: works only inside *one* framework; lock-in.
- **Identity layers** (Vercel Passport, Okta/IAM): govern *who* the agent is, not *what* it may do or whether it can *prove* it.

**Warrant sits in the gap and does what none do: ENFORCE deterministic policy at the moment of action
+ PROVE it cryptographically and portably + across ANY framework + inside the operator's own systems.**
Enforce + prove + portable + sovereign + deterministic.

**Why it's hard for others to copy (honest moat):**
1. **Rare skill mix in one head:** cryptography/protocol (hash chains, signatures, attestation) +
   policy-engine design + ports-and-adapters neutrality. The agent crowd lacks the crypto depth; the
   crypto crowd is not in the agent space.
2. **Platforms structurally won't:** a neutral cross-runtime layer is the opposite of the lock-in
   Vercel/LangChain want; they build governance INTO their own framework. The gap is an independent's to own.
3. **Harder posture:** watching is easy; fail-closed enforcement + tamper-evidence is a discipline
   (two adversarial reviews on this build caught real holes a "best-effort filter" would ship).

**The moat is a head start, not an unbreakable secret:** early + correct + runtime-neutral + provable
while the field is still watching, filtering text, or framework-locked. Front-page properties: (1) the
gate is *code, not another AI*, so it cannot be prompt-talked into "yes"; (2) the proof is
*mathematics, not a dashboard*, provable to a third party without trusting the operator.

## §6 The path (and the content gate)

1. **Now → architecture v1:** (a) Milestone B + ceremony, (b) `warrant-mcp` adapter, (c) name +
   document the ports (Gate / Ledger / enforcement seam) + adapter-author's guide.
2. **Then → content generation** (the explicit gate; do NOT start content until v1 is true): repo
   READMEs, the "why agent accountability is the elephant + here is working proof" case study, the
   adversarial-review-caught-a-real-bypass story, the LinkedIn narrative.
3. **Downstream (bet, not faith; validate with first reactions before committing):** open-core (OSS
   the kernel, commercial Gatewerk + a managed audit console), the compliance/provenance category
   framing, sitting beside identity layers (Passport governs *who*; warrant governs *what* + proof).

**Portfolio role throughout:** each adapter is a repo-grade, externally-verifiable piece; the
methodology (build → adversarial review → fix) is the headline; the artifact reframes Idris from
"automation configurer" to "architect of the trust/audit layer for AI agents." FT read: "I build the
trust layer for AI agents." Client read: "I make your agents safe, auditable, and compliant."
