import { describe, expect, it } from 'vitest';
import type { RunReport } from '../src/types.js';
import { renderProofMarkdown } from '../src/render.js';

// `violations` became required when authorization reporting landed, and this fixture never
// gained it. Untyped, it was therefore the LEGACY shape: renderProofMarkdown saw no
// violations field and every assertion below was in fact being made against a report
// stamped AUTHORIZATION STATUS UNKNOWN. It is meant to be a clean run, so it gets [].
const RPT: RunReport = {
  runId: 'run-r1', generatedAt: '2026-07-16T12:00:00Z', chainVerified: true,
  violations: [],
  journeys: [{ requestId: 'req-1', warrantId: 'w-1', actionKind: 'send_email', target: 'a@b.com',
    path: 'human', ruleId: 'cold-email-hiring-manager', reviewRef: 'rev-1',
    executed: true, outcome: 'queued', attestedBy: 'op-1' }],
  counts: { requested: 1, auto: 0, human: 1, denied: 0, executed: 1, attested: 1, trajectoryProven: 0 },
};
describe('renderProofMarkdown', () => {
  it('includes runId in title', () => { expect(renderProofMarkdown(RPT)).toContain('run-r1'); });
  it('includes verified badge', () => {
    expect(renderProofMarkdown(RPT)).toMatch(/✓.*[Vv]erified|chain.*verified/i);
  });
  it('counts table has numeric cell', () => {
    expect(renderProofMarkdown(RPT)).toMatch(/\|\s*1\s*\|/);
  });
  it('journey section has ruleId + reviewRef + attestedBy', () => {
    const md = renderProofMarkdown(RPT);
    expect(md).toContain('cold-email-hiring-manager');
    expect(md).toContain('rev-1');
    expect(md).toContain('op-1');
  });
  it('a journey with nothing to say about context or trajectory says nothing', () => {
    // The absent states must not render a line at all. A "trajectory: n/a" row would train a
    // reader to skim past the row that matters when it says UNPROVEN.
    const md = renderProofMarkdown(RPT);
    expect(md).not.toContain('context bound');
    expect(md).not.toContain('trajectory:');
    expect(md).toContain('| trajectory proven | 0 |');
  });

  it('an unbound context is stated as NO, not omitted', () => {
    const md = renderProofMarkdown({
      ...RPT,
      journeys: [{ ...RPT.journeys[0]!, contextBinding: 'unbound' }],
    });
    expect(md).toContain('context bound');
    expect(md).toContain('NO');
    expect(md).toContain('not re-derivable');
  });

  it('a proven trajectory renders its root; an unproven one renders UNPROVEN and the reason', () => {
    const root = 'a'.repeat(64);
    const proven = renderProofMarkdown({
      ...RPT,
      counts: { ...RPT.counts, trajectoryProven: 1 },
      journeys: [{ ...RPT.journeys[0]!, trajectory: { state: 'proven', inputsRoot: root, leafCount: 3, computedRoot: root } }],
    });
    expect(proven).toContain('inputs proven');
    expect(proven).toContain(root);
    expect(proven).toContain('| trajectory proven | 1 |');

    const unproven = renderProofMarkdown({
      ...RPT,
      journeys: [{ ...RPT.journeys[0]!, trajectory: { state: 'unproven', inputsRoot: root, leafCount: 3, reason: 'no leaf set was supplied' } }],
    });
    expect(unproven).toContain('UNPROVEN');
    expect(unproven).toContain('no leaf set was supplied');
  });

  it('a legacy report with no trajectoryProven still renders the row as 0', () => {
    // Same reasoning as the violations field above: a report produced before the question was
    // asked must not render as though the answer were yes. It has zero proven trajectories.
    const legacy = { ...RPT, counts: { ...RPT.counts, trajectoryProven: undefined } } as unknown as RunReport;
    expect(renderProofMarkdown(legacy)).toContain('| trajectory proven | 0 |');
  });

  it('an empty violations array renders neither banner', () => {
    // Pins the difference the fixture used to blur. `violations: []` is a run checked and
    // found clean; a missing field is a run never checked. Every assertion above passed
    // under the second, so none of them could tell the two apart.
    const md = renderProofMarkdown(RPT);
    expect(md).not.toMatch(/AUTHORIZATION STATUS UNKNOWN/);
    expect(md).not.toMatch(/AUTHORIZATION VIOLATIONS/);
  });
});
