import type { Result } from '@idriszade/core';
import { err, ok } from '@idriszade/core';
import { canonicalJson, sha256Hex } from '@idriszade/warrant-core';
import type { TrajectoryAttestedPayload, WarrantError } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { verifyChain } from './chain.js';
import { foldInputsRoot, parseTrajectoryAttested } from './trajectory.js';
import type { TrajectoryLeafSource } from './trajectory.js';
import type { RunReport, RunViolation, WarrantJourney } from './types.js';

export interface ReplayOptions {
  /**
   * Where to get the leaves the ledger deliberately does not hold. Omitted means every
   * attested trajectory reports `unproven` with that stated as the reason, which is honest,
   * because a verifier with no leaf set genuinely cannot reproduce the root.
   */
  readonly leaves?: TrajectoryLeafSource;
}

/** What `warrant.requested` recorded, kept for the two post-loop bindings. */
interface RequestedFacts {
  seq: number;
  /** Distinguishes "no context key in the payload" from "context present but empty". */
  hasContext: boolean;
  context: unknown;
}

/** `context.inputsRoot` if the requester claimed one. */
function claimedInputsRoot(context: unknown): string | undefined {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return undefined;
  const v = (context as Record<string, unknown>)['inputsRoot'];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Verifies the chain first, then folds all 11 event types for the given runId into
 * a RunReport. `now` is injected: no new Date() in domain logic (golden tests depend on it).
 * Counts are journey-derived, except that `requested` counts only journeys a
 * requestId-carrying event actually contributed to: a journey synthesized from an
 * unresolvable warrantId records an action nobody requested, and counting it as a request
 * overstates the run in the certificate's headline number.
 *
 * Correlation strategy:
 * - requestId-carrying events (warrant.requested, policy.evaluated, review.submitted,
 *   review.decided, warrant.denied) key journeys by requestId directly.
 * - warrant.issued carries BOTH requestId and warrantId: sets journey.warrantId and
 *   builds a warrantId→requestId map for downstream correlation.
 * - warrantId-only events (action.executed, action.outcome, operator.attested) resolve
 *   requestId via the map; if no mapping exists, key by 'warrant:<warrantId>' so counts
 *   remain honest and the anomaly is visible.
 * - trajectory.attested carries requestId but is an ANNOTATION on a request rather than a
 *   request, so it joins a journey without marking it request-backed. See the fold below.
 */
export function replayRun(
  entries: LedgerEntry[],
  runId: string,
  now: () => Date,
  opts: ReplayOptions = {},
): Result<RunReport, WarrantError> {
  const cv = verifyChain(entries);
  if (cv.error) return err(cv.error);

  const run = entries.filter((e) => e.runId === runId);
  const map = new Map<string, Partial<WarrantJourney>>();
  // warrantId → requestId resolution map (populated from warrant.issued events)
  const warrantToRequest = new Map<string, string>();
  // Keys a requestId-carrying event contributed to. counts.requested is derived from
  // this rather than from journeys.length, because a journey synthesized from an
  // unresolvable warrantId is the trace of an unauthorized action, not of a request.
  // Membership is by key rather than by prefix so a payload that literally names its
  // requestId 'warrant:x' is still counted: the set records what actually happened.
  const requestBacked = new Set<string>();
  // Facts the two post-loop bindings need. Held separately from the journey because they are
  // evidence ABOUT a journey rather than fields of the certificate: the raw context and the
  // sequence numbers are inputs to a check, not things a reader is shown.
  const requested = new Map<string, RequestedFacts>();
  const evaluatedContextHash = new Map<string, string>();
  const attested = new Map<string, { seq: number; payload: TrajectoryAttestedPayload }>();
  const violations: RunViolation[] = [];

  const get = (id: string): Partial<WarrantJourney> => {
    if (!map.has(id)) map.set(id, { requestId: id, executed: false });
    return map.get(id)!;
  };

  /** get() for a requestId-carrying event: the key it uses is a real request. */
  const getRequested = (id: string): Partial<WarrantJourney> => {
    requestBacked.add(id);
    return get(id);
  };

  // An id is present or it is not. `undefined` and `''` are both absent, and an absent id must
  // never become a journey key: every one used to collapse into one shared `'__unknown__'`
  // journey, merging unrelated actions into a fabricated one (see `RunViolation.kind`).
  const present = (v: string | undefined): v is string => typeof v === 'string' && v !== '';

  // Surfaced, never folded. A verifier that quietly drops an entry it cannot place is doing the
  // thing this package exists to stop the ledger doing.
  const orphan = (e: LedgerEntry, what: string): void => {
    violations.push({
      requestId: `seq:${e.seq}`,
      kind: 'orphaned_entry',
      detail: `${what} at seq ${e.seq} carries no usable requestId, so it cannot be placed in a journey`,
    });
  };

  for (const e of run) {
    const p = e.payload as Record<string, unknown>;
    const reqId = p['requestId'] as string | undefined;
    const wId = p['warrantId'] as string | undefined;

    switch (e.event) {
      // requestId-carrying events: key directly by requestId
      case 'warrant.requested': {
        if (!present(reqId)) { orphan(e, 'warrant.requested'); break; }
        const key = reqId;
        const j = getRequested(key);
        j.actionKind = p['actionKind'] as string;
        j.target = p['target'] as string;
        // First wins. A second warrant.requested for one requestId is already anomalous; the
        // bindings below must be checked against the request that policy actually evaluated,
        // which is the first, not whatever was appended last.
        if (!requested.has(key)) {
          requested.set(key, { seq: e.seq, hasContext: 'context' in p, context: p['context'] });
        }
        break;
      }
      case 'policy.evaluated': {
        if (!present(reqId)) { orphan(e, 'policy.evaluated'); break; }
        const key = reqId;
        const j = getRequested(key);
        j.ruleId = p['ruleId'] as string;
        j.path = p['path'] as WarrantJourney['path'];
        const ch = p['contextHash'];
        if (typeof ch === 'string' && !evaluatedContextHash.has(key)) evaluatedContextHash.set(key, ch);
        break;
      }
      case 'review.submitted': {
        if (!present(reqId)) { orphan(e, 'review.submitted'); break; }
        const j = getRequested(reqId);
        j.reviewRef = p['reviewId'] as string;
        break;
      }
      case 'review.decided': {
        // Informational: it does not create a journey, it only joins one that exists. But it DOES
        // carry a requestId (`warrant-eve/src/resume.ts:229`), so an absent one is unplaceable in
        // exactly the same way as its neighbours. It used to be skipped silently: the only branch
        // that did not fabricate a key, and also the only one that dropped the entry without
        // saying so. Both halves are now the same rule.
        if (!present(reqId)) { orphan(e, 'review.decided'); break; }
        getRequested(reqId);
        break;
      }
      case 'warrant.denied': {
        if (!present(reqId)) { orphan(e, 'warrant.denied'); break; }
        const j = getRequested(reqId);
        j.path = 'denied';
        break;
      }
      // warrant.issued carries BOTH requestId and warrantId: build correlation map
      case 'warrant.issued': {
        if (!present(reqId)) { orphan(e, 'warrant.issued'); break; }
        const j = getRequested(reqId);
        if (wId) {
          j.warrantId = wId;
          if (reqId) warrantToRequest.set(wId, reqId);
        }
        break;
      }
      // warrantId-only events: resolve requestId via the correlation map
      case 'action.executed': {
        if (!present(reqId) && !present(wId)) { orphan(e, e.event); break; }
        const resolvedReqId = (reqId ?? (wId ? warrantToRequest.get(wId) : undefined))
          ?? `warrant:${wId!}`;
        const j = get(resolvedReqId);
        j.executed = true;
        break;
      }
      case 'action.outcome': {
        if (!present(reqId) && !present(wId)) { orphan(e, e.event); break; }
        const resolvedReqId = (reqId ?? (wId ? warrantToRequest.get(wId) : undefined))
          ?? `warrant:${wId!}`;
        const j = get(resolvedReqId);
        j.outcome = p['status'] as string;
        break;
      }
      // An annotation ON a request, appended by the producer upstream of Warrant.
      case 'trajectory.attested': {
        const parsed = parseTrajectoryAttested(e.payload);
        if (parsed.error) {
          // NOT skipped. Replay ignores unknown event TYPES silently by design, and the
          // contract names that as the reason this fold had to land before anything emitted
          // the event. A known event carrying an uncheckable payload is the same fail-open one
          // level down, so it surfaces instead of vanishing.
          violations.push({
            requestId: reqId ?? `seq:${e.seq}`,
            kind: 'trajectory_payload_malformed',
            detail: `trajectory.attested at seq ${e.seq} carries a payload this verifier cannot check (${parsed.error.message})`,
          });
          break;
        }
        const t = parsed.data;
        // get(), NOT getRequested(). An attestation is not a request. Counting it as one would
        // let a trajectory event naming a requestId nobody requested inflate counts.requested
        // this is the same fail-open the requestBacked set was introduced to close for orphaned
        // executions, arriving through a different door.
        get(t.requestId);
        if (!attested.has(t.requestId)) attested.set(t.requestId, { seq: e.seq, payload: t });
        break;
      }
      case 'operator.attested': {
        if (!present(reqId) && !present(wId)) { orphan(e, e.event); break; }
        const resolvedReqId = (reqId ?? (wId ? warrantToRequest.get(wId) : undefined))
          ?? `warrant:${wId!}`;
        const j = get(resolvedReqId);
        // attestedBy comes from the entry's principal.id: the payload stores warrantId + step,
        // not a separate attestedBy field. principal is typed as Principal { kind, id }.
        j.attestedBy = (e.principal as { id?: string }).id ?? 'unknown';
        break;
      }
      default:
        break;
    }
  }

  const journeys = [...map.values()] as WarrantJourney[];

  // ── The context binding ────────────────────────────────────────────────────────────────
  //
  // evaluate() is pure over (request, policy), so history reaches it through request.context
  // and never through the engine. The consequence is that a verdict which depended on context
  // is only re-derivable from the ledger if the ledger binds the context to the evaluation.
  // warrant.requested records what the requester claimed; contextHash on policy.evaluated
  // records what the engine was handed. Checking that they agree is what makes the pair a
  // binding rather than two independent assertions.
  for (const j of journeys) {
    const req = requested.get(j.requestId);
    if (req === undefined || !req.hasContext) continue; // nothing recorded, nothing to bind
    const claimed = evaluatedContextHash.get(j.requestId);
    if (claimed === undefined) {
      j.contextBinding = 'unbound';
      continue;
    }
    let actual: string | null = null;
    try {
      actual = sha256Hex(canonicalJson(req.context));
    } catch {
      // canonicalJson throws by design and the context came off a file. A context that cannot
      // be canonicalised cannot have produced the hash a conforming producer wrote, so this
      // fails closed as a mismatch rather than reading as unknown.
      actual = null;
    }
    if (actual !== null && actual === claimed) {
      j.contextBinding = 'bound';
    } else {
      j.contextBinding = 'mismatch';
      violations.push({
        requestId: j.requestId,
        kind: 'context_hash_mismatch',
        detail: actual === null
          ? `policy.evaluated recorded contextHash ${claimed}, but the context in warrant.requested cannot be canonicalised, so what policy evaluated cannot be reproduced`
          : `policy.evaluated recorded contextHash ${claimed}, but the context in warrant.requested hashes to ${actual}`,
      });
    }
  }

  // ── The trajectory ─────────────────────────────────────────────────────────────────────
  for (const j of journeys) {
    const req = requested.get(j.requestId);
    const att = attested.get(j.requestId);
    const claimedRoot = req?.hasContext === true ? claimedInputsRoot(req.context) : undefined;

    if (att === undefined) {
      // A request that claimed attested provenance with nothing backing it. This direction
      // matters more than it looks: the governance rule the root exists to make expressible is
      // "deny if inputsRoot is absent", and that rule is worth nothing if a PRESENT root need
      // not correspond to a real attestation. Policy may have allowed the action because
      // provenance was claimed.
      if (claimedRoot !== undefined) {
        violations.push({
          requestId: j.requestId,
          kind: 'trajectory_missing',
          detail: `request.context claimed inputsRoot ${claimedRoot} but the chain carries no trajectory.attested for this request`,
        });
      }
      continue; // no event: an action-only proof, and the certificate claims nothing further
    }

    // Inputs are attested BEFORE authority is requested. Afterwards is not evidence.
    if (req !== undefined && att.seq >= req.seq) {
      violations.push({
        requestId: j.requestId,
        kind: 'trajectory_out_of_order',
        detail: `trajectory.attested at seq ${att.seq} was appended at or after warrant.requested at seq ${req.seq}; an attestation made once authority was already requested is a claim, not evidence`,
      });
    }

    // The root appearing in two places is a binding, not duplication: the trajectory cannot be
    // swapped without changing what policy saw.
    if (claimedRoot !== undefined && claimedRoot !== att.payload.inputsRoot) {
      violations.push({
        requestId: j.requestId,
        kind: 'trajectory_root_mismatch',
        detail: `request.context claimed inputsRoot ${claimedRoot} but trajectory.attested attests ${att.payload.inputsRoot}`,
      });
    }

    const base = { inputsRoot: att.payload.inputsRoot, leafCount: att.payload.leafCount };
    const supplied = opts.leaves?.leavesFor(j.requestId);

    if (supplied === undefined) {
      // The honest row. The producer's store is rebuildable and disposable by design, so
      // losing it costs the fuller proof and never the chain's integrity. Stated, not hidden.
      j.trajectory = {
        ...base,
        state: 'unproven',
        reason: 'no leaf set was supplied to the verifier; the leaves live in the producer\'s own store, not in the ledger',
      };
      continue;
    }

    const folded = foldInputsRoot(supplied);
    if (folded.error) {
      // A leaf file this tool cannot parse is a bad input to the tool, not evidence that the
      // operator's agent misbehaved, so it is reported and not counted as a violation.
      j.trajectory = { ...base, state: 'unproven', reason: `supplied leaf set is unusable: ${folded.error.message}` };
      continue;
    }

    if (folded.data.inputsRoot === att.payload.inputsRoot && folded.data.leafCount === att.payload.leafCount) {
      j.trajectory = { ...base, state: 'proven', computedRoot: folded.data.inputsRoot };
      continue;
    }

    j.trajectory = {
      ...base,
      state: 'unproven',
      computedRoot: folded.data.inputsRoot,
      reason: `supplied leaf set (${folded.data.leafCount} leaves) folds to ${folded.data.inputsRoot}`,
    };
    // Distinct from an absent leaf set. Absent is a missing piece of evidence; present and
    // contradictory is two documents that cannot both be true, so the run is not clean.
    violations.push({
      requestId: j.requestId,
      kind: 'trajectory_leaves_mismatch',
      detail: `trajectory.attested attests inputsRoot ${att.payload.inputsRoot} over ${att.payload.leafCount} leaves, but the supplied leaf set (${folded.data.leafCount} leaves) folds to ${folded.data.inputsRoot}`,
    });
  }

  // Authorization invariants, which are a different question from chain integrity.
  // A run where policy denied an action and the action executed anyway has a
  // perfectly intact chain: the ledger faithfully recorded a governance failure.
  // Reporting that as clean would produce a certificate asserting the opposite of
  // what the ledger says, so the violations travel with the report and the CLI
  // refuses to call such a run verified.
  for (const j of journeys) {
    if (j.executed && j.path === 'denied') {
      violations.push({
        requestId: j.requestId,
        kind: 'executed_after_deny',
        detail: `action ${j.actionKind} to ${j.target} executed despite a denied verdict (ruleId ${j.ruleId})`,
      });
    }
    if (j.executed && j.warrantId === undefined) {
      violations.push({
        requestId: j.requestId,
        kind: 'executed_without_warrant',
        detail: `action ${j.actionKind} to ${j.target} executed with no warrant.issued in the chain`,
      });
    }
  }

  return ok({
    runId,
    generatedAt: now().toISOString(),
    chainVerified: true,
    violations,
    journeys,
    counts: {
      // NOT journeys.length: that counted the synthetic `warrant:<id>` journeys too, so a
      // run with one request and one orphaned execution reported two requests.
      requested: journeys.filter((j) => requestBacked.has(j.requestId)).length,
      auto: journeys.filter((j) => j.path === 'auto').length,
      human: journeys.filter((j) => j.path === 'human').length,
      denied: journeys.filter((j) => j.path === 'denied').length,
      executed: journeys.filter((j) => j.executed).length,
      attested: journeys.filter((j) => j.attestedBy !== undefined).length,
      trajectoryProven: journeys.filter((j) => j.trajectory?.state === 'proven').length,
    },
  });
}
