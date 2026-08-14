/**
 * The policy document's shape.
 *
 * **Every object here is `strictObject`, and that is a security control rather than tidiness.**
 * `z.object` SILENTLY STRIPS unknown keys, and the evaluator
 * reads an absent constraint as *no constraint*:
 *
 *   `evaluate.ts:57`: `rule.match.audience === undefined || rule.match.audience === audience`
 *
 * So the two failure halves compose into a policy-widening typo. Measured against the shipped
 * `warrant-pack-gtm` default, changing `audience:` to `audiance:` on ONE rule:
 *
 *   shipped        loadPolicy=ok  path=human  rule=cold-email-hiring-manager
 *   one-char typo  loadPolicy=ok  path=auto   rule=reply-existing-thread
 *
 * A cold outbound email the operator's policy says requires a human is auto-approved and signed
 * with `verdictPath: 'auto'`. **`loadPolicy` returned `ok` both times.**
 *
 * **And the certificate could not show it.** `load.ts:30` hashes the *parsed* document, so the
 * stripped key never enters `policyHash`; the hashed doc reads `{"actionKind":"send_email"}`. An
 * auditor replaying the run gets a self-consistent proof of a policy nobody wrote. That is the
 * worst shape a defect can take in this repo: not a broken proof, a **valid proof of the wrong
 * thing**.
 *
 * This is invariant 2 (*"Deny-by-default everywhere. Unmatched denies. Malformed denies rather
 * than throwing."*) applied one level up, at the document rather than the request: **a policy the
 * loader cannot fully account for is malformed, and malformed denies.** A key the runtime silently
 * drops is a key an author believes is doing something, the argument millwerk already wrote down
 * for its manifest registry (`millwerk/src/adapters/registry.ts:106-107`) and uses `z.strictObject`
 * for throughout. Warrant's own policy loader was the last place in the workspace still permissive.
 *
 * **Not covered by strictness, deliberately, and recorded rather than half-fixed:**
 * `caps.perPrincipalDaily` is a `z.record`, so it accepts ANY key by construction: `send_emails`
 * for `send_email` loads clean and leaves the real action uncapped (`evaluate.ts:41` reads an
 * absent cap as *uncapped*). Strictness cannot reach inside a record. The candidate fix is to
 * refuse a cap naming an `actionKind` no stakes rule mentions: sound, because such a cap is
 * necessarily dead config (an unmatched action already hits `default-deny`), but it couples two
 * sections of the document and could reject a config someone legitimately staged ahead of its
 * rule. **Different risk profile from this change, which cannot make anything more permissive, so
 * it gets its own decision instead of riding along on this one.**
 */
import { z } from 'zod';

export const PolicyDocSchema = z.strictObject({
  version: z.string(),
  defaults: z.strictObject({ path: z.literal('deny') }),
  stakes: z.array(
    z.strictObject({
      id: z.string(),
      match: z.strictObject({
        actionKind: z.string(),
        /** Absent means *any audience* (`evaluate.ts:57`). That is the intended reading, and it
         *  is exactly why a misspelt key must not be allowed to produce it. */
        audience: z.string().optional(),
      }),
      path: z.enum(['auto', 'human']),
    }),
  ),
  protectedAudiences: z.array(z.string()),
  caps: z.strictObject({
    perPrincipalDaily: z.record(z.string(), z.number().int().positive()),
  }),
});

export type PolicyDoc = z.infer<typeof PolicyDocSchema>;
