/**
 * What the run proves about the inputs behind one proposed action.
 *
 * The contract's first state (`trajectory.attested` absent) is represented by this field
 * being absent, not by a third enum member. An action with no attestation is an action-only
 * proof, and the certificate makes no trajectory claim at all about it.
 */
export interface JourneyTrajectory {
  /**
   * `proven`: leaves were supplied and reproduced the attested root.
   * `unproven`: the event is present but the root was not reproduced. A missing leaf set is a
   * real state, not an error: the producer's store is rebuildable and disposable by design,
   * so losing it costs the fuller proof and never the chain's integrity. It must be stated
   * rather than hidden, which is why there is no `unknown` that renders as nothing.
   */
  state: 'proven' | 'unproven';
  /** The root as attested in the ledger. */
  inputsRoot: string;
  /** The leaf count as attested. */
  leafCount: number;
  /** Recomputed from the supplied leaves. Absent when no leaf set was supplied. */
  computedRoot?: string;
  /** Why unproven. Absent when proven. */
  reason?: string;
}

export interface WarrantJourney {
  requestId: string;
  warrantId?: string;
  actionKind: string;
  target: string;
  path: 'auto' | 'human' | 'denied';
  ruleId: string;
  reviewRef?: string;
  executed: boolean;
  outcome?: string;
  attestedBy?: string;
  /**
   * Whether `policy.evaluated` bound the context the engine actually saw.
   *
   * `evaluate()` is pure over `(request, policy)`, so history enters through
   * `request.context`, which means a verdict that depended on context is only re-derivable
   * from the ledger if the ledger binds the context to the evaluation. `warrant.requested`
   * records the context the requester claimed; `contextHash` on `policy.evaluated` binds what
   * the engine was handed. `unbound` is a pre-binding ledger: the context is recorded but
   * nothing ties it to the verdict, which is materially weaker and must be readable as such.
   *
   * Absent when `warrant.requested` recorded no context at all: there is nothing to bind.
   */
  contextBinding?: 'bound' | 'unbound' | 'mismatch';
  /** Absent means no `trajectory.attested` for this request: an action-only proof. */
  trajectory?: JourneyTrajectory;
}

/**
 * An authorization invariant the run broke.
 *
 * Chain integrity and authorization are different questions, and until now only the
 * first was checked. A run in which policy DENIED an action and the action executed
 * anyway has a perfectly intact hash chain: every entry is correctly linked, because
 * the ledger faithfully recorded a governance failure. Verifying the chain and
 * declaring the run clean would produce a certificate asserting the opposite of what
 * the ledger plainly says.
 */
export interface RunViolation {
  requestId: string;
  /**
   * The trajectory kinds are governance failures for the same reason the first two are: the
   * chain is intact and the ledger is faithfully recording a contradiction.
   *
   * - `trajectory_payload_malformed`: a `trajectory.attested` whose payload does not parse.
   *   Someone appended an attestation this verifier cannot check. Shrugging at it is the same
   *   fail-open as replay silently ignoring an unknown event.
   * - `trajectory_out_of_order`: appended at or after `warrant.requested`. An attestation
   *   made after authority was requested is a claim, not evidence.
   * - `trajectory_missing`: `context.inputsRoot` was present, so policy could have allowed
   *   the action *because* provenance was claimed, and no attestation backs the claim.
   * - `trajectory_root_mismatch`: the root policy saw and the root attested differ. The two
   *   copies are a binding, not duplication; a disagreement means the trajectory was swapped
   *   relative to what was evaluated.
   * - `trajectory_leaves_mismatch`: leaves WERE supplied and do not fold to the attested
   *   root. Distinct from an absent leaf set: absent is a missing piece of evidence, whereas
   *   present-and-contradictory is two documents that cannot both be true.
   * - `context_hash_mismatch`: the recorded context does not hash to what
   *   `policy.evaluated` says the engine evaluated.
   */
  kind:
    /**
     * `orphaned_entry`: a requestId-carrying event that carries no requestId (or a
     * warrantId-only event carrying neither id). It is surfaced rather than folded, because
     * folding it required inventing a key: every such entry used to land in one shared
     * `'__unknown__'` journey, where **entries from unrelated actions merged into a single
     * fabricated one.** Two consequences, both traced: `warrant.issued` set that journey's
     * `warrantId` without populating the correlation map, so `action.executed` resolved to the
     * same shared object and `executed_without_warrant` never fired; and `warrant.denied` set
     * `path: 'denied'` on it, so one id-less denial could make `executed_after_deny` fire
     * against the wrong action or mask a real one.
     *
     * The guard already existed on `review.decided` and on no other branch. This is the
     * neighbour rule: the repair was scoped to the case being looked at.
     */
    | 'orphaned_entry'
    | 'executed_after_deny'
    | 'executed_without_warrant'
    | 'trajectory_payload_malformed'
    | 'trajectory_out_of_order'
    | 'trajectory_missing'
    | 'trajectory_root_mismatch'
    | 'trajectory_leaves_mismatch'
    | 'context_hash_mismatch';
  detail: string;
}

export interface RunReport {
  runId: string;
  generatedAt: string;
  chainVerified: true;
  /** Empty on a clean run. Non-empty means the ledger records a governance failure. */
  violations: RunViolation[];
  journeys: WarrantJourney[];
  counts: {
    requested: number;
    auto: number;
    human: number;
    denied: number;
    executed: number;
    attested: number;
    /**
     * Journeys whose inputs were reproduced from the producer's leaf set. Deliberately NOT
     * "journeys carrying a trajectory event": an attestation nobody checked is a claim, and
     * the headline number on a certificate must count proofs, not claims.
     */
    trajectoryProven: number;
  };
}
