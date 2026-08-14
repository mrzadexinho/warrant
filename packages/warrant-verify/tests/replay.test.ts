import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import { replayRun } from '../src/replay.js';

const P = { kind: 'agent' as const, id: 'agent-1' };
const OP = { kind: 'human' as const, id: 'op-1' };
const AT = '2026-07-16T10:00:00Z';
const RUN = 'run-abc';

function chain(items: Omit<LedgerEntry, 'seq' | 'prevHash' | 'hash'>[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < items.length; i++) {
    const base = { ...items[i]!, seq: i + 1, prevHash: prev };
    const hash = entryHash(base);
    entries.push({ ...base, hash });
    prev = hash;
  }
  return entries;
}

const ENTRIES = chain([
  { runId: RUN, at: AT, event: 'warrant.requested' as const, principal: P,
    payload: { requestId: 'req-1', actionKind: 'send_email', target: 'a@b.com' } },
  { runId: RUN, at: AT, event: 'policy.evaluated' as const, principal: P,
    payload: { requestId: 'req-1', ruleId: 'cold-email-hiring-manager', path: 'human' } },
  { runId: RUN, at: AT, event: 'review.submitted' as const, principal: P,
    payload: { requestId: 'req-1', reviewId: 'rev-1' } },
  { runId: RUN, at: AT, event: 'review.decided' as const, principal: OP,
    payload: { requestId: 'req-1', reviewId: 'rev-1', decision: 'approved' } },
  { runId: RUN, at: AT, event: 'warrant.issued' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1' } },
  { runId: RUN, at: AT, event: 'action.executed' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1', nonce: 'n-1' } },
  { runId: RUN, at: AT, event: 'action.outcome' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1', status: 'queued' } },
  { runId: RUN, at: AT, event: 'operator.attested' as const, principal: OP,
    payload: { requestId: 'req-1', warrantId: 'w-1', attestedBy: 'op-1' } },
]);

const NOW = () => new Date('2026-07-16T12:00:00.000Z'); // injected clock, golden-stable

describe('replayRun', () => {
  it('returns err chain_broken on a tampered chain', () => {
    const bad = ENTRIES.map((e, i) => i === 2 ? { ...e, payload: { tampered: true } } : e);
    expect(replayRun(bad, RUN, NOW).error?.code).toBe('chain_broken');
  });

  it('builds RunReport with correct counts', () => {
    const r = replayRun(ENTRIES, RUN, NOW);
    expect(r.error).toBeNull();
    const rpt = r.data!;
    expect(rpt.runId).toBe(RUN);
    expect(rpt.chainVerified).toBe(true);
    expect(rpt.generatedAt).toBe('2026-07-16T12:00:00.000Z');
    expect(rpt.counts.requested).toBe(1);
    expect(rpt.counts.human).toBe(1);
    expect(rpt.counts.auto).toBe(0);
    expect(rpt.counts.denied).toBe(0);
    expect(rpt.counts.executed).toBe(1);
    expect(rpt.counts.attested).toBe(1);
    // This fixture carries no trajectory.attested and no context, so the certificate makes no
    // trajectory claim and nothing to bind: both new fields stay absent rather than defaulting
    // to something that reads as a pass.
    expect(rpt.counts.trajectoryProven).toBe(0);
    expect(rpt.journeys[0]!.trajectory).toBeUndefined();
    expect(rpt.journeys[0]!.contextBinding).toBeUndefined();
    expect(rpt.journeys).toHaveLength(1);
  });

  it('golden snapshot of RunReport (fully deterministic via injected clock)', () => {
    expect(replayRun(ENTRIES, RUN, NOW).data!).toMatchSnapshot();
  });

  it('2 requests each issued+executed: counts.executed===2 and each journey has own warrantId', () => {
    // Simulates the real executor pattern: warrant.issued carries requestId+warrantId,
    // but action.executed/outcome carry only warrantId (domain-blind executor).
    // replayRun must correlate via the warrantId→requestId map built from warrant.issued.
    const TWO_REQ = 'run-two';
    const entries = chain([
      // Request 1: auto path
      { runId: TWO_REQ, at: AT, event: 'warrant.requested' as const, principal: P,
        payload: { requestId: 'req-a', actionKind: 'send_email', target: 'a@cold.example' } },
      { runId: TWO_REQ, at: AT, event: 'policy.evaluated' as const, principal: P,
        payload: { requestId: 'req-a', ruleId: 'cold-email-hiring-manager', path: 'auto' } },
      { runId: TWO_REQ, at: AT, event: 'warrant.issued' as const, principal: P,
        payload: { requestId: 'req-a', warrantId: 'w-alpha' } },
      // executor emits warrantId only (domain-blind)
      { runId: TWO_REQ, at: AT, event: 'action.executed' as const, principal: P,
        payload: { warrantId: 'w-alpha', nonce: 'n-a', to: 'a@cold.example' } },
      { runId: TWO_REQ, at: AT, event: 'action.outcome' as const, principal: P,
        payload: { warrantId: 'w-alpha', status: 'queued' } },
      // Request 2: auto path
      { runId: TWO_REQ, at: AT, event: 'warrant.requested' as const, principal: P,
        payload: { requestId: 'req-b', actionKind: 'send_email', target: 'b@cold.example' } },
      { runId: TWO_REQ, at: AT, event: 'policy.evaluated' as const, principal: P,
        payload: { requestId: 'req-b', ruleId: 'cold-email-hiring-manager', path: 'auto' } },
      { runId: TWO_REQ, at: AT, event: 'warrant.issued' as const, principal: P,
        payload: { requestId: 'req-b', warrantId: 'w-beta' } },
      { runId: TWO_REQ, at: AT, event: 'action.executed' as const, principal: P,
        payload: { warrantId: 'w-beta', nonce: 'n-b', to: 'b@cold.example' } },
      { runId: TWO_REQ, at: AT, event: 'action.outcome' as const, principal: P,
        payload: { warrantId: 'w-beta', status: 'queued' } },
    ]);

    const r = replayRun(entries, TWO_REQ, NOW);
    expect(r.error).toBeNull();
    const rpt = r.data!;
    expect(rpt.counts.requested).toBe(2);
    expect(rpt.counts.executed).toBe(2);
    expect(rpt.counts.auto).toBe(2);
    expect(rpt.journeys).toHaveLength(2);
    const jA = rpt.journeys.find((j) => j.requestId === 'req-a');
    const jB = rpt.journeys.find((j) => j.requestId === 'req-b');
    expect(jA).toBeDefined();
    expect(jA!.warrantId).toBe('w-alpha');
    expect(jA!.executed).toBe(true);
    expect(jB).toBeDefined();
    expect(jB!.warrantId).toBe('w-beta');
    expect(jB!.executed).toBe(true);
  });
});

// counts.requested was journeys.length, and journeys included the synthetic
// `warrant:<id>` entry replayRun creates when an action.executed names a warrant that has
// no warrant.issued anywhere in the run. That entry is not a request. It is the trace of
// an action that was never authorized, and counting it inflates the one number in the
// certificate a reader treats as "how many actions this run asked to take". A certificate
// that overstates its own request count is a certificate asserting something untrue, in
// the same direction as the anomaly it is reporting.
describe('replayRun counts.requested excludes journeys with no request behind them', () => {
  const ORPHAN_RUN = 'run-orphan';

  /** One legitimate request, plus an action.executed naming a warrant nobody issued. */
  function withOrphan(): LedgerEntry[] {
    return chain([
      { runId: ORPHAN_RUN, at: AT, event: 'warrant.requested' as const, principal: P,
        payload: { requestId: 'req-real', actionKind: 'send_email', target: 'ok@acme.com' } },
      { runId: ORPHAN_RUN, at: AT, event: 'policy.evaluated' as const, principal: P,
        payload: { requestId: 'req-real', ruleId: 'known-audience', path: 'auto' } },
      { runId: ORPHAN_RUN, at: AT, event: 'warrant.issued' as const, principal: P,
        payload: { requestId: 'req-real', warrantId: 'w-real' } },
      { runId: ORPHAN_RUN, at: AT, event: 'action.executed' as const, principal: P,
        payload: { warrantId: 'w-real', nonce: 'n-1' } },
      // No warrant.requested, no warrant.issued: this warrantId resolves to nothing.
      { runId: ORPHAN_RUN, at: AT, event: 'action.executed' as const, principal: P,
        payload: { warrantId: 'w-ghost', nonce: 'n-2' } },
      { runId: ORPHAN_RUN, at: AT, event: 'action.outcome' as const, principal: P,
        payload: { warrantId: 'w-ghost', status: 'queued' } },
    ]);
  }

  it('counts one request, not two, when an orphan warrant executed', () => {
    const rpt = replayRun(withOrphan(), ORPHAN_RUN, NOW).data!;
    expect(rpt.counts.requested).toBe(1);
  });

  it('still surfaces the orphan: the journey and its violation both survive', () => {
    // Excluding it from the count must not mean hiding it. The anomaly is the finding.
    const rpt = replayRun(withOrphan(), ORPHAN_RUN, NOW).data!;
    expect(rpt.journeys).toHaveLength(2);
    expect(rpt.journeys.map((j) => j.requestId)).toContain('warrant:w-ghost');
    expect(rpt.counts.executed).toBe(2);
    const orphanViolations = rpt.violations.filter((v) => v.kind === 'executed_without_warrant');
    expect(orphanViolations).toHaveLength(1);
    expect(orphanViolations[0]!.requestId).toBe('warrant:w-ghost');
  });

  it('a warrantId-only event whose warrant WAS issued still counts as its request', () => {
    // The positive case, and the one that a fix over-narrowed into "only count journeys
    // that saw a warrant.requested" would break: req-real's action.executed carries no
    // requestId either, and it must resolve rather than be written off as an orphan.
    const rpt = replayRun(withOrphan(), ORPHAN_RUN, NOW).data!;
    const real = rpt.journeys.find((j) => j.requestId === 'req-real');
    expect(real).toBeDefined();
    expect(real!.executed).toBe(true);
    expect(real!.warrantId).toBe('w-real');
  });

  it('a run with no orphans counts every journey, so the exclusion is not blanket', () => {
    const rpt = replayRun(ENTRIES, RUN, NOW).data!;
    expect(rpt.counts.requested).toBe(rpt.journeys.length);
    expect(rpt.counts.requested).toBe(1);
  });

  // One row per requestId-carrying event, each as the SOLE carrier for its journey. An
  // adversarial review measured that the earlier single row here (warrant.issued) pinned
  // only that one call site: reverting any of the other five to plain get() left all 109
  // tests green, and a denied-only fragment would then report requested 0 alongside a
  // listed denied journey, the mirror of the bug this commit fixes. Every fixture in the
  // suite is multi-carrier, and requestBacked is keyed by requestId, so one surviving
  // carrier re-adds the key and hides the mutation. Single-carrier runs are the only shape
  // that isolates each site.
  it.each([
    ['warrant.requested', { requestId: 'req-solo', actionKind: 'send_email', target: 'a@b.com' }],
    ['policy.evaluated', { requestId: 'req-solo', ruleId: 'r', path: 'auto' }],
    ['review.submitted', { requestId: 'req-solo', reviewId: 'rev-1' }],
    ['review.decided', { requestId: 'req-solo', reviewId: 'rev-1', decision: 'approved' }],
    ['warrant.denied', { requestId: 'req-solo', reason: 'human_rejected' }],
    ['warrant.issued', { requestId: 'req-solo', warrantId: 'w-solo' }],
  ])('%s alone backs a request, so the rule is not narrowed to one carrier', (event, payload) => {
    const SOLO = `run-solo-${event}`;
    const rpt = replayRun(
      chain([{ runId: SOLO, at: AT, event: event as LedgerEntry['event'], principal: P, payload }]),
      SOLO,
      NOW,
    ).data!;
    expect(rpt.journeys).toHaveLength(1);
    expect(rpt.journeys[0]!.requestId).toBe('req-solo');
    expect(rpt.counts.requested).toBe(1);
  });
});
