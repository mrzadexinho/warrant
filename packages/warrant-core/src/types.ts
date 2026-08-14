import { z } from 'zod';

// strict: a principal is copied verbatim into ledger entries (warrant-pack-gtm's
// executor appends `warrant.principal` raw), and entryHash covers whatever it is
// handed. A stripping schema let an unknown key ride through verification unsigned
// and unread; a strict one refuses it at the door. See WarrantSchema below.
export const PrincipalSchema = z.strictObject({
  kind: z.enum(['agent', 'human', 'external']),
  id: z.string().min(1),
});
export type Principal = z.infer<typeof PrincipalSchema>;

// Upper bound on action.target. The target is an addressee (email, URL, phone, handle);
// 4096 chars is generous for all of them, and an unbounded target is a resource-exhaustion
// vector in any matcher that scales with its length. Policy's evaluate() enforces the same
// bound itself because it cannot assume its caller parsed the request.
export const MAX_TARGET_LENGTH = 4096;

export const ActionRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  principal: PrincipalSchema,
  action: z.object({
    kind: z.string().min(1),
    target: z.string().min(1).max(MAX_TARGET_LENGTH),
    params: z.unknown(),
  }),
  context: z.record(z.string(), z.unknown()),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

// ── trajectory.attested ──────────────────────────────────────────────────────
//
// Contract: docs/contracts/trajectory-attested.md. Digest version 1; any change to leaf or
// root construction bumps it and is breaking.
//
// These live in warrant-core rather than in warrant-ledger (which owns the event NAME) or
// warrant-verify (which owns the fold) because Millwerk depends on `@idriszade/warrant-core`
// and on nothing else in this workspace. A payload contract the producer cannot import is a
// payload contract the producer hand-rolls forever, and then the two sides drift by typo.

/**
 * A Merkle leaf as the producer states it. The ledger never holds these; it holds the root.
 * The verifier hashes them itself rather than trusting the producer's leaf digests, which is
 * why the leaf INPUT is the interchange shape and the digest is not.
 */
export const TrajectoryLeafSchema = z.strictObject({
  /** What sort of input: 'observation' | 'signal' | 'dossier' | 'contact' | … */
  kind: z.string().min(1),
  /** Stable pointer into the producer's own store. */
  ref: z.string().min(1),
  /** sha256 hex of canonicalJson of the value actually used. */
  valueHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TrajectoryLeaf = z.infer<typeof TrajectoryLeafSchema>;

/**
 * strict, for the same reason WarrantSchema is: `entryHash` covers the entire payload, so an
 * unknown key rides inside the hash-chained document while no verifier ever reads it. That is
 * the hole `intoto.ts`'s subject binding closes one document up, and the fix belongs at both
 * levels. A producer that legitimately needs another field bumps `digestVersion`.
 */
export const TrajectoryAttestedPayloadSchema = z.strictObject({
  requestId: z.string().min(1),
  digestVersion: z.literal(1),
  algo: z.literal('sha256'),
  leafCount: z.number().int().min(1),
  inputsRoot: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TrajectoryAttestedPayload = z.infer<typeof TrajectoryAttestedPayloadSchema>;

export const VerdictSchema = z.object({
  path: z.enum(['auto', 'human', 'deny']),
  ruleId: z.string(),
  policyVersion: z.string(),
  policyHash: z.string(),
  reason: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// strict, top level and nested. The warrant is the product's central signed claim, and
// a stripping schema made "verified" mean "the schema fields verify", leaving anything
// else in the document unsigned, unread and unrefused. intoto.ts's hasExactKeys already
// takes this position for the statement's subject; the warrant is the more
// security-critical document and had the weaker rule.
//
// The trade: adding a field to a warrant is now a lockstep upgrade, since an older
// verifier refuses a newer warrant outright rather than ignoring the new field, and
// Warrant carries no version to negotiate with. Acceptable while this is pre-1.0 and
// issuer and verifier ship from one repo. Revisit if a warrant ever has to cross a
// version boundary.
export const WarrantSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  principal: PrincipalSchema,
  action: z.strictObject({
    kind: z.string(),
    target: z.string(),
    paramsHash: z.string().length(64),
  }),
  policyVersion: z.string(),
  policyHash: z.string(),
  verdictPath: z.enum(['auto', 'human']),
  reviewRef: z.string().optional(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  nonce: z.string(),
  signature: z.string(),
});
export type Warrant = z.infer<typeof WarrantSchema>;
