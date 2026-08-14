/**
 * The trajectory fold, and the seam it has to hold.
 *
 * Contract: ../../../docs/contracts/trajectory-attested.md
 *
 * The two vectors at the top are the Millwerk↔Warrant seam. They are written as plain
 * `toBe('…')` literals rather than inline snapshots ON PURPOSE: a snapshot can be regenerated
 * with `vitest -u` by anyone who sees it fail, and the correct response to one of these failing
 * is never to update it. If a vector moves, either this fold or Millwerk's diverged, roots stop
 * reproducing, and every certificate ever issued becomes unverifiable.
 *
 * Millwerk's side: `millwerk/tests/trajectory.test.ts`, describe('shared vectors').
 */

import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import { canonicalJson, sha256Hex } from '@idriszade/warrant-core';
import { foldInputsRoot, leafDigest, merkleRoot, parseTrajectoryAttested } from '../src/trajectory.js';
import { replayRun } from '../src/replay.js';
import type { TrajectoryLeafSource } from '../src/trajectory.js';

const h = (c: string): string => c.repeat(64);
const leaf = (kind: string, ref: string, valueHash: string) => ({ kind, ref, valueHash });

const VECTOR_1 = [leaf('observation', 'obs-1', h('a'))];
const VECTOR_1_ROOT = '8325e200ff9cabf22e06d42bab724d478d6a69612b198f786fa03c45228c2cf3';

const VECTOR_2 = [
  leaf('observation', 'obs-1', h('a')),
  leaf('signal', 'evt-9', h('b')),
  leaf('dossier', 'dos-3', h('c')),
];
const VECTOR_2_ROOT = 'bbe08411eb499f08f0408eafcdcf9a4ba92df80ad13302504ab21fefc1fb59c7';

describe('conformance vectors: computed by Millwerk against the real canonicalJson', () => {
  it('vector 1: a single observation leaf is its own root', () => {
    const r = foldInputsRoot(VECTOR_1);
    expect(r.error).toBeNull();
    expect(r.data!.inputsRoot).toBe(VECTOR_1_ROOT);
    expect(r.data!.leafCount).toBe(1);
    // Single leaf: inputsRoot IS the leaf, no node hashing at all.
    expect(leafDigest(VECTOR_1[0]!).data).toBe(VECTOR_1_ROOT);
  });

  it('vector 2: three mixed-kind leaves', () => {
    const r = foldInputsRoot(VECTOR_2);
    expect(r.error).toBeNull();
    expect(r.data!.inputsRoot).toBe(VECTOR_2_ROOT);
    expect(r.data!.leafCount).toBe(3);
  });

  it('vector 2 is independent of the order the verifier is handed', () => {
    // The verifier must not be steerable by the producer's ordering.
    expect(foldInputsRoot([...VECTOR_2].reverse()).data!.inputsRoot).toBe(VECTOR_2_ROOT);
    expect(foldInputsRoot([VECTOR_2[1]!, VECTOR_2[2]!, VECTOR_2[0]!]).data!.inputsRoot).toBe(VECTOR_2_ROOT);
  });
});

describe('fold construction', () => {
  it('promotes an odd digest unchanged rather than duplicating it', () => {
    // Duplication is the CVE-2012-2459 second-preimage shape: it would collapse a 3-leaf tree
    // and the 4-leaf tree with the last leaf repeated onto one root. Vector 2 is the vector
    // that catches this, which is why it has three leaves and not two or four.
    const three = ['a', 'b', 'c'].map(h).sort();
    expect(merkleRoot(three)).not.toBe(merkleRoot([...three, three[2]!]));
  });

  it('domain-separates leaves from internal nodes', () => {
    const two = foldInputsRoot([leaf('observation', 'obs-1', h('a')), leaf('observation', 'obs-2', h('b'))]);
    const l1 = leafDigest(leaf('observation', 'obs-1', h('a'))).data!;
    const l2 = leafDigest(leaf('observation', 'obs-2', h('b'))).data!;
    expect(two.data!.inputsRoot).not.toBe(l1);
    expect(two.data!.inputsRoot).not.toBe(l2);
  });

  it('is stable across key order: canonicalisation, not JSON.stringify order', () => {
    expect(leafDigest({ valueHash: h('a'), ref: 'obs-1', kind: 'observation' }).data).toBe(VECTOR_1_ROOT);
  });

  it('rejects an empty leaf set: leafCount must be >= 1', () => {
    expect(foldInputsRoot([]).error?.code).toBe('trajectory_no_leaves');
  });

  it('rejects a leaf whose valueHash is not sha256 hex, naming the index', () => {
    const r = foldInputsRoot([VECTOR_1[0]!, leaf('signal', 'evt-1', 'not-a-hash')]);
    expect(r.error?.code).toBe('trajectory_leaf_malformed');
    expect(r.error?.message).toContain('index 1');
  });

  it('rejects a leaf carrying an extra key: strict, so nothing rides unread', () => {
    expect(foldInputsRoot([{ ...VECTOR_1[0]!, extra: 'unread' }]).error?.code).toBe('trajectory_leaf_malformed');
  });

  it('rejects a leaf that is not an object at all', () => {
    expect(foldInputsRoot(['nope']).error?.code).toBe('trajectory_leaf_malformed');
    expect(foldInputsRoot([null]).error?.code).toBe('trajectory_leaf_malformed');
  });
});

describe('parseTrajectoryAttested', () => {
  const good = { requestId: 'req-1', digestVersion: 1, algo: 'sha256', leafCount: 1, inputsRoot: VECTOR_1_ROOT };

  it('accepts the contract payload', () => {
    expect(parseTrajectoryAttested(good).data).toEqual(good);
  });

  it('refuses a bumped digestVersion: a new fold is a breaking change, not a new field', () => {
    expect(parseTrajectoryAttested({ ...good, digestVersion: 2 }).error?.code).toBe('trajectory_payload_malformed');
  });

  it('refuses an unknown algo', () => {
    expect(parseTrajectoryAttested({ ...good, algo: 'sha512' }).error?.code).toBe('trajectory_payload_malformed');
  });

  it('refuses an extra key: entryHash covers it, so nothing may ride unread', () => {
    expect(parseTrajectoryAttested({ ...good, note: 'unread' }).error?.code).toBe('trajectory_payload_malformed');
  });

  it('refuses leafCount 0: an attestation over nothing attests nothing', () => {
    expect(parseTrajectoryAttested({ ...good, leafCount: 0 }).error?.code).toBe('trajectory_payload_malformed');
  });
});

// ── replay integration ───────────────────────────────────────────────────────────────────────

const P = { kind: 'agent' as const, id: 'agent-1' };
const AT = '2026-07-16T10:00:00Z';
const RUN = 'run-traj';
const NOW = () => new Date('2026-07-16T12:00:00.000Z');

function chain(items: Omit<LedgerEntry, 'seq' | 'prevHash' | 'hash'>[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < items.length; i++) {
    const base = { ...items[i]!, seq: i + 1, prevHash: prev };
    const hash = entryHash(base);
    out.push({ ...base, hash });
    prev = hash;
  }
  return out;
}

const ev = (event: LedgerEntry['event'], payload: unknown) => ({ runId: RUN, at: AT, event, principal: P, payload });

const trajectoryEvent = (root: string, leafCount: number, requestId = 'req-1') =>
  ev('trajectory.attested', { requestId, digestVersion: 1, algo: 'sha256', leafCount, inputsRoot: root });

/** context, and the contextHash a conforming producer writes for it. */
const withContext = (context: Record<string, unknown>) => ({
  requested: ev('warrant.requested', { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com', context }),
  evaluated: ev('policy.evaluated', {
    requestId: 'req-1', ruleId: 'known-audience', path: 'auto', contextHash: sha256Hex(canonicalJson(context)),
  }),
});

const source = (leaves: readonly unknown[], requestId = 'req-1'): TrajectoryLeafSource => ({
  leavesFor: (id) => (id === requestId ? leaves : undefined),
});

const only = (entries: LedgerEntry[], opts?: { leaves?: TrajectoryLeafSource }) => {
  const r = replayRun(entries, RUN, NOW, opts);
  expect(r.error).toBeNull();
  return r.data!;
};

describe('replayRun folds trajectory.attested', () => {
  it('no event: no trajectory claim at all, an action-only proof', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1' });
    const rpt = only(chain([requested, evaluated]));
    expect(rpt.journeys[0]!.trajectory).toBeUndefined();
    expect(rpt.counts.trajectoryProven).toBe(0);
    expect(rpt.violations).toEqual([]);
  });

  it('event present, no leaf set supplied: UNPROVEN and says why, and the run is still clean', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_2_ROOT });
    const rpt = only(chain([trajectoryEvent(VECTOR_2_ROOT, 3), requested, evaluated]));
    const t = rpt.journeys[0]!.trajectory!;
    expect(t.state).toBe('unproven');
    expect(t.inputsRoot).toBe(VECTOR_2_ROOT);
    expect(t.leafCount).toBe(3);
    expect(t.computedRoot).toBeUndefined();
    expect(t.reason).toContain('no leaf set');
    // A rebuildable store that was not handed over is a missing piece of evidence, not a
    // governance failure. Exit code must stay green.
    expect(rpt.violations).toEqual([]);
    expect(rpt.counts.trajectoryProven).toBe(0);
  });

  it('event present, leaves supplied and matching: PROVEN', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_2_ROOT });
    const rpt = only(chain([trajectoryEvent(VECTOR_2_ROOT, 3), requested, evaluated]), { leaves: source(VECTOR_2) });
    const t = rpt.journeys[0]!.trajectory!;
    expect(t.state).toBe('proven');
    expect(t.computedRoot).toBe(VECTOR_2_ROOT);
    expect(t.reason).toBeUndefined();
    expect(rpt.counts.trajectoryProven).toBe(1);
    expect(rpt.violations).toEqual([]);
  });

  it('leaves supplied that fold to something else: UNPROVEN and a violation', () => {
    // Distinct from an absent leaf set. Two documents that cannot both be true.
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_2_ROOT });
    const rpt = only(chain([trajectoryEvent(VECTOR_2_ROOT, 3), requested, evaluated]), { leaves: source(VECTOR_1) });
    expect(rpt.journeys[0]!.trajectory!.state).toBe('unproven');
    expect(rpt.journeys[0]!.trajectory!.computedRoot).toBe(VECTOR_1_ROOT);
    expect(rpt.violations.map((v) => v.kind)).toEqual(['trajectory_leaves_mismatch']);
  });

  it('an unusable leaf file is reported, not counted as a governance failure', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_2_ROOT });
    const rpt = only(chain([trajectoryEvent(VECTOR_2_ROOT, 3), requested, evaluated]), {
      leaves: source(['garbage']),
    });
    expect(rpt.journeys[0]!.trajectory!.state).toBe('unproven');
    expect(rpt.journeys[0]!.trajectory!.reason).toContain('unusable');
    expect(rpt.violations).toEqual([]);
  });

  it('a malformed payload is a violation, never silently skipped', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1' });
    const rpt = only(chain([
      ev('trajectory.attested', { requestId: 'req-1', digestVersion: 1, algo: 'sha256', leafCount: 3 }),
      requested, evaluated,
    ]));
    expect(rpt.violations.map((v) => v.kind)).toEqual(['trajectory_payload_malformed']);
    expect(rpt.journeys[0]!.trajectory).toBeUndefined();
  });

  it('attested AFTER warrant.requested is a claim, not evidence', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_1_ROOT });
    const rpt = only(chain([requested, trajectoryEvent(VECTOR_1_ROOT, 1), evaluated]), { leaves: source(VECTOR_1) });
    expect(rpt.violations.map((v) => v.kind)).toEqual(['trajectory_out_of_order']);
    // The root still reproduces. Ordering and reproducibility are separate questions and the
    // report must not collapse them: the inputs ARE those inputs, they just prove nothing about
    // what drove the request.
    expect(rpt.journeys[0]!.trajectory!.state).toBe('proven');
  });

  it('context.inputsRoot disagreeing with the attested root is a violation: the two are a binding', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_1_ROOT });
    const rpt = only(chain([trajectoryEvent(VECTOR_2_ROOT, 3), requested, evaluated]), { leaves: source(VECTOR_2) });
    expect(rpt.violations.map((v) => v.kind)).toEqual(['trajectory_root_mismatch']);
    // The trajectory itself reproduces: the failure is that it is not the trajectory policy saw.
    expect(rpt.journeys[0]!.trajectory!.state).toBe('proven');
  });

  it('a claimed inputsRoot with no attestation behind it is a violation', () => {
    // "deny if inputsRoot is absent" is worth nothing if a PRESENT root need not correspond to
    // a real attestation: policy may have allowed the action because provenance was claimed.
    const { requested, evaluated } = withContext({ entityId: 'e-1', inputsRoot: VECTOR_1_ROOT });
    const rpt = only(chain([requested, evaluated]));
    expect(rpt.violations.map((v) => v.kind)).toEqual(['trajectory_missing']);
  });

  it('an attestation naming a requestId nobody requested does not inflate counts.requested', () => {
    // Same fail-open the requestBacked set closed for orphaned executions, arriving through a
    // different door: an attestation is an annotation ON a request, not a request.
    const rpt = only(chain([trajectoryEvent(VECTOR_1_ROOT, 1, 'ghost-req')]));
    expect(rpt.counts.requested).toBe(0);
    expect(rpt.journeys).toHaveLength(1);
    expect(rpt.journeys[0]!.requestId).toBe('ghost-req');
    expect(rpt.journeys[0]!.trajectory!.state).toBe('unproven');
  });
});

describe('replayRun folds the context binding', () => {
  it('contextHash reproducing the recorded context is bound', () => {
    const { requested, evaluated } = withContext({ entityId: 'e-1', sentTodayByKind: { send_email: 2 } });
    const rpt = only(chain([requested, evaluated]));
    expect(rpt.journeys[0]!.contextBinding).toBe('bound');
    expect(rpt.violations).toEqual([]);
  });

  it('a context recorded with no contextHash reads as unbound, never as fine', () => {
    const rpt = only(chain([
      ev('warrant.requested', { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com', context: { entityId: 'e-1' } }),
      ev('policy.evaluated', { requestId: 'req-1', ruleId: 'known-audience', path: 'auto' }),
    ]));
    expect(rpt.journeys[0]!.contextBinding).toBe('unbound');
    // Weaker, but not a governance failure: every pre-binding ledger is in this state.
    expect(rpt.violations).toEqual([]);
  });

  it('no context recorded at all: nothing to bind, so nothing is claimed', () => {
    const rpt = only(chain([
      ev('warrant.requested', { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com' }),
      ev('policy.evaluated', { requestId: 'req-1', ruleId: 'known-audience', path: 'auto' }),
    ]));
    expect(rpt.journeys[0]!.contextBinding).toBeUndefined();
  });

  it('a contextHash that does not reproduce is a violation', () => {
    const rpt = only(chain([
      ev('warrant.requested', { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com', context: { entityId: 'e-1' } }),
      ev('policy.evaluated', { requestId: 'req-1', ruleId: 'known-audience', path: 'auto', contextHash: h('0') }),
    ]));
    expect(rpt.journeys[0]!.contextBinding).toBe('mismatch');
    expect(rpt.violations.map((v) => v.kind)).toEqual(['context_hash_mismatch']);
  });

  it('the mismatch catches a swapped context, which is the whole point', () => {
    // The context policy evaluated said one cap; the context in the chain says another.
    const evaluated = withContext({ entityId: 'e-1', sentTodayByKind: { send_email: 2 } }).evaluated;
    const requested = ev('warrant.requested', {
      requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com',
      context: { entityId: 'e-1', sentTodayByKind: { send_email: 0 } },
    });
    const rpt = only(chain([requested, evaluated]));
    expect(rpt.violations.map((v) => v.kind)).toEqual(['context_hash_mismatch']);
  });
});
