# Contract: `trajectory.attested`

**Status:** Specified and **implemented on Warrant's side**. Owner: Warrant.
Consumer: Millwerk (Composer port).
**Resolves:** does the certificate prove the trajectory or only the action.
**Digest version:** 1. Any change to leaf or root construction bumps this and is a breaking change.

Where it lives now:

| Piece | Where |
|---|---|
| Event name | `warrant-ledger/src/entry.ts`, `LedgerEventType` |
| Payload schema | `warrant-core/src/types.ts`, `TrajectoryAttestedPayloadSchema`, `TrajectoryLeafSchema` |
| The fold | `warrant-verify/src/trajectory.ts` |
| The checks | `warrant-verify/src/replay.ts`, post-loop |
| Warrant's vectors | `warrant-verify/tests/trajectory.test.ts` |
| CLI | `warrant-verify --leaves <file>` |

**The schemas live in `warrant-core`, not in the ledger or the verifier**, because Millwerk depends
on `@idriszade/warrant-core` and on nothing else in this workspace. A payload contract the producer
cannot import is one the producer hand-rolls forever, and then the two sides drift by typo. Both are
`z.strictObject` rather than the `z.object` first written here: `entryHash` covers the whole payload,
so an unknown key rides inside the hash-chained document while no verifier ever reads it, the same
hole `intoto.ts`'s subject binding closes one document up.

## What it is

An optional ledger event that binds a proposed action to the exact inputs that produced it, without
putting those inputs in the ledger. The ledger carries a **root**; the leaves stay in the producer's
own store. This keeps "the ledger records decisions, not observations" true, keeps the row a constant
size regardless of input count, and keeps the producer's store rebuildable: losing it costs the fuller
proof, never the chain's integrity.

## Payload

```ts
export const TrajectoryAttestedPayload = z.object({
  requestId:     z.string().min(1),        // ties to ActionRequest.id
  digestVersion: z.literal(1),
  algo:          z.literal('sha256'),
  leafCount:     z.number().int().min(1),
  inputsRoot:    z.string().regex(/^[0-9a-f]{64}$/),
});
```

Appended by the **proposer** (Millwerk), `principal.kind = 'agent'`, once per `ActionRequest`.

## Leaf construction

```
leafInput = { kind, ref, valueHash }
  kind      string  what sort of input: 'observation' | 'signal' | 'dossier' | 'contact' | …
  ref       string  stable pointer into the producer's own store
  valueHash string  sha256 hex of canonicalJson of the value actually used

leaf = sha256( 0x00 || utf8(canonicalJson(leafInput)) )
```

**Use `canonicalJson` from `@idriszade/warrant-core`. Do not reimplement it.** A second
implementation of the function that defines identity is the same class of mistake as a second guard:
if the two ever diverge, roots stop reproducing and every prior certificate becomes unverifiable.

**`canonicalJson` throws on hostile input by design.** Leaf values are caller data, so every call
site must catch and return a typed error rather than propagating the throw.

## Root construction

Binary Merkle tree, RFC 6962 style, over leaves **sorted lexicographically by their hex digest** so
the root is independent of the producer's ordering.

```
node = sha256( 0x01 || left || right )     // raw 32-byte digests, not hex
odd node count at a level: promote the last digest unchanged
leafCount == 1: inputsRoot == that leaf
```

Leaves are domain-separated with `0x00` and internal nodes with `0x01`. This is not decoration: it is
what stops a crafted internal node from being presented as a leaf.

**Why a Merkle tree rather than a hash over the sorted list:** selective disclosure. An operator can
prove one specific input was used, with an inclusion path, without revealing the rest of the dossier.
That is a real capability for a compliance buyer, and retrofitting it later would break
`digestVersion`. Pay it once, now.

## Conformance vectors

Computed by Millwerk against the real `canonicalJson` from `@idriszade/warrant-core` (not
a stand-in). **`warrant-verify`'s fold must reproduce these byte for byte.** Source of truth:
`millwerk/tests/trajectory.test.ts`, `describe('shared vectors')`.

**Reproduced by `warrant-verify`'s independent fold, first run, no adjustment.** Warrant's
copy is in `warrant-verify/tests/trajectory.test.ts` as plain `toBe('…')` literals rather than inline
snapshots, deliberately: a snapshot can be regenerated with `vitest -u` by whoever sees it fail, and
updating one of these is never the correct response to it failing.

**The Merkle fold is reimplemented on Warrant's side on purpose, and `canonicalJson` is not.** A
verifier that imports the producer's fold proves only that the producer agrees with itself, so the two
folds are independent and pinned to each other by these vectors. A verifier with a second
`canonicalJson` is the opposite case: that function defines identity, and divergence would stop every
prior root reproducing. So `warrant-verify` imports `canonicalJson` and reimplements everything above
it, which is why the vectors are load-bearing rather than decorative.

`valueHash` values below are a single character repeated 64 times.

| # | Leaves (`kind`, `ref`, `valueHash`) | `inputsRoot` |
|---|---|---|
| 1 | `observation`, `obs-1`, `'a'×64` | `8325e200ff9cabf22e06d42bab724d478d6a69612b198f786fa03c45228c2cf3` |
| 2 | `observation`/`obs-1`/`'a'×64`, `signal`/`evt-9`/`'b'×64`, `dossier`/`dos-3`/`'c'×64` | `bbe08411eb499f08f0408eafcdcf9a4ba92df80ad13302504ab21fefc1fb59c7` |

Vector 2 is the one that catches a wrong odd-count rule: a fold that **duplicates** the last digest
instead of **promoting** it produces a different root. That difference is deliberate and is the
CVE-2012-2459 second-preimage shape, so it must be pinned by a test on both sides, not just described.

`canonicalJson` is **injected, not imported**, at every call site (`buildTrajectory(canonicalJson,
inputs)`). This is what makes it structurally impossible for a second copy to grow. A throw on a
hostile leaf value fails that one leaf with its index (`{code: 'noncanonical_input', index}`) rather
than propagating.

## Ordering constraint

For a given `requestId`, `seq(trajectory.attested) < seq(warrant.requested)`. Inputs are attested
*before* authority is requested; an attestation appended afterwards is not evidence, it is a claim.
`warrant-verify` enforces this and fails the run's trajectory section if violated.

## Verification

The verifier recomputes the root from the producer's leaf list and compares it to `inputsRoot`. The
leaves reach it through `TrajectoryLeafSource` (`replayRun(entries, runId, now, { leaves })`), or
through `warrant-verify --leaves <file>` for a third party holding only the bin.

**Four outcomes, not three.** This table originally lumped "leaves unavailable" together with "root
mismatch"; implementing it showed they are different claims and the exit code has to tell them apart.

| State | Certificate says | Run clean? |
|---|---|---|
| event absent | action-only proof, no trajectory claim | yes |
| event present, leaves match | **inputs proven** | yes |
| event present, **no leaf set supplied** | **trajectory unproven**, with that as the stated reason | **yes** |
| event present, leaves supplied and folding to another root | **trajectory unproven** + `trajectory_leaves_mismatch` | **no** |

The third row stays clean on purpose: the producer's store is rebuildable and disposable by design, so
a leaf set nobody handed over is a missing piece of evidence, not a governance failure. The fourth is
two documents that cannot both be true, so the run is not clean. The distinction is the whole reason
`state: 'unproven'` carries a `reason`.

An unparseable leaf *file* is reported as `unproven` with the parse failure named, and raises no
violation: that is a bad input to the tool, not evidence the operator's agent misbehaved.

### Three checks beyond reproducing the root

Ordering, and the two bindings. All three are governance failures: the chain is intact and is
faithfully recording a contradiction.

| Kind | Fires when |
|---|---|
| `trajectory_payload_malformed` | a `trajectory.attested` payload does not parse. **Not skipped:** replay ignores unknown event *types* silently by design, and shrugging at a known type with an uncheckable payload is that same fail-open one level down. |
| `trajectory_out_of_order` | `seq(trajectory.attested) >= seq(warrant.requested)` |
| `trajectory_missing` | `context.inputsRoot` is present and **no** `trajectory.attested` backs it |
| `trajectory_root_mismatch` | `context.inputsRoot !== trajectory.inputsRoot` |

`trajectory_missing` was not in the original spec and is the one that makes the rest worth having.
The governance rule the root exists to make expressible is *"deny if `inputsRoot` is absent"*, and that
rule is worth nothing if a **present** root need not correspond to a real attestation: policy may have
allowed the action precisely because provenance was claimed.

Ordering and reproducibility are reported separately and never collapsed: an out-of-order attestation
whose root still reproduces is `proven` **and** a violation. The inputs are those inputs; they just
prove nothing about what drove the request.

An attestation naming a `requestId` nobody requested joins its journey via `get()` rather than
`getRequested()`, so it cannot inflate `counts.requested`. An attestation is an annotation *on* a
request, not a request; the same fail-open the `requestBacked` set closed for orphaned executions,
arriving through a different door.

`counts.trajectoryProven` counts journeys whose inputs were **reproduced**, never journeys carrying the
event. An attestation nobody checked is a claim, and a certificate's headline number must count proofs.

## What this does not do

It does not put observations in the ledger, does not make `evaluate()` impure, does not add a write
per entity (one row per *proposed action*, not per entity swept), and does not change the chain
format. Adding the event type required no migration: `warrant_ledger.event` is plain `TEXT` with no
CHECK constraint, and `replay.ts` ignores unknown events via `default: break`.

**Implementation order: teach `warrant-verify` to fold this event before anything emits it.** Because
replay ignores unknown events silently, emitting first would produce certificates that quietly omit
the trajectory and still look correct. ✅ **Done. Nothing in the workspace emits it yet, so
Millwerk is now free to.**
