/**
 * The trajectory fold: Warrant's half of `trajectory.attested`.
 *
 * Contract: ../../../docs/contracts/trajectory-attested.md. Digest version 1.
 *
 * Two rules pull in opposite directions here, and both are load-bearing.
 *
 *  1. **The Merkle fold is reimplemented on purpose.** A verifier that imports the producer's
 *     fold proves only that the producer agrees with itself. Millwerk's
 *     `src/trajectory/merkle.ts` and this file are independent implementations pinned to each
 *     other by shared conformance vectors, tested on both sides. That is the normal shape for
 *     an attestation format, and it is the entire reason the vectors exist.
 *
 *  2. **`canonicalJson` is NOT reimplemented, ever.** It is the function that defines
 *     identity. A second copy that drifts stops every prior root reproducing and silently
 *     invalidates every certificate ever issued, the same class of mistake as a second
 *     guard. Imported from `@idriszade/warrant-core`, which is where it lives.
 *
 * `canonicalJson` throws on hostile input by design, and leaves arrive from a file a third
 * party handed this tool. Every call site here catches and returns a typed error.
 */

import { createHash } from 'node:crypto';
import type { Result } from '@idriszade/core';
import { err, ok } from '@idriszade/core';
import { canonicalJson, TrajectoryAttestedPayloadSchema, TrajectoryLeafSchema } from '@idriszade/warrant-core';
import type { TrajectoryAttestedPayload, TrajectoryLeaf, WarrantError } from '@idriszade/warrant-core';

/** Domain separation. Not decoration: it is what stops a crafted internal node being presented as a leaf. */
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

function invalid(code: string, message: string): WarrantError {
  return { type: 'validation', code, message };
}

// Uint8Array rather than Buffer throughout the tree: node's Buffer is generic over its backing
// ArrayBuffer, and createHash().digest() and Buffer.from(hex) do not agree on that parameter.
function sha256Raw(prefix: number, ...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  h.update(Uint8Array.of(prefix));
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

/** `leaf = sha256( 0x00 || utf8(canonicalJson({kind, ref, valueHash})) )` */
export function leafDigest(leaf: TrajectoryLeaf): Result<string, WarrantError> {
  let canonical: string;
  try {
    canonical = canonicalJson({ kind: leaf.kind, ref: leaf.ref, valueHash: leaf.valueHash });
  } catch (e) {
    return err(invalid('noncanonical_input', `leaf ${leaf.ref} is not canonicalisable: ${String(e)}`));
  }
  return ok(toHex(sha256Raw(LEAF_PREFIX, new TextEncoder().encode(canonical))));
}

/**
 * RFC 6962-style binary Merkle root. `node = sha256( 0x01 || left || right )` over **raw
 * 32-byte digests**, not hex. An odd digest at a level is **promoted unchanged**, never
 * duplicated: duplicating it is the CVE-2012-2459 second-preimage shape, where a 3-leaf tree
 * and a 4-leaf tree with the last leaf repeated collapse to the same root.
 *
 * Precondition: every element is 64 lowercase hex characters. Callers reach this through
 * `foldInputsRoot`, which validates via `TrajectoryLeafSchema` first.
 */
export function merkleRoot(sortedLeafDigestsHex: readonly string[]): string {
  let level = sortedLeafDigestsHex.map(fromHex);
  if (level.length === 1) return toHex(level[0]!);

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : sha256Raw(NODE_PREFIX, left, right));
    }
    level = next;
  }
  return toHex(level[0]!);
}

/**
 * Recompute `inputsRoot` from a producer's leaf list.
 *
 * Leaves are sorted lexicographically by hex digest, so the root is independent of the
 * producer's ordering: the verifier must not be able to be steered by the order it is
 * handed. Input is `unknown[]` because it comes from a file, and each element is validated.
 */
export function foldInputsRoot(
  leaves: readonly unknown[],
): Result<{ inputsRoot: string; leafCount: number }, WarrantError> {
  if (leaves.length === 0) {
    return err(invalid('trajectory_no_leaves', 'leaf set is empty; leafCount must be >= 1'));
  }

  const digests: string[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const parsed = TrajectoryLeafSchema.safeParse(leaves[i]);
    if (!parsed.success) {
      return err(invalid('trajectory_leaf_malformed', `leaf at index ${i} is not a valid trajectory leaf`));
    }
    const d = leafDigest(parsed.data);
    if (d.error) return err(d.error);
    digests.push(d.data);
  }

  digests.sort();
  return ok({ inputsRoot: merkleRoot(digests), leafCount: digests.length });
}

/**
 * Parse a `trajectory.attested` payload off the chain.
 *
 * A payload that does not parse is NOT ignored. `replay.ts` ignores unknown event *types*
 * silently by design, and the contract calls that out as the reason the fold had to land
 * before anything emitted the event; an event of a known type carrying an uncheckable payload
 * is the same fail-open one level down, so the caller raises it as a violation.
 */
export function parseTrajectoryAttested(payload: unknown): Result<TrajectoryAttestedPayload, WarrantError> {
  const parsed = TrajectoryAttestedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return err(invalid('trajectory_payload_malformed', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')));
  }
  return ok(parsed.data);
}

/** Supplies the leaves the ledger deliberately does not hold. They live in the producer's own store. */
export interface TrajectoryLeafSource {
  /** Leaves for a requestId, or `undefined` when this verifier holds no leaf set for it. */
  leavesFor(requestId: string): readonly unknown[] | undefined;
}
