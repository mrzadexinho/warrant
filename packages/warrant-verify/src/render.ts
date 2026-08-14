import type { RunReport } from './types.js';

export function renderProofMarkdown(r: RunReport): string {
  const { runId, generatedAt, counts: c, journeys } = r;
  const lines = [
    `# Warrant Run Proof: ${runId}`, '',
    `**Chain Verified:** ✓ verified · **Generated:** ${generatedAt}`, '',
    '## Counts', '', '| Metric | Value |', '|---|---|',
    `| requested | ${c.requested} |`, `| auto | ${c.auto} |`, `| human | ${c.human} |`,
    `| denied | ${c.denied} |`, `| executed | ${c.executed} |`, `| attested | ${c.attested} |`,
    // `?? 0` rather than omitting the row: a report produced before trajectory folding has
    // zero proven trajectories, which is exactly what a reader should see. Dropping the row
    // would let an older certificate read as though the question had not been asked.
    `| trajectory proven | ${c.trajectoryProven ?? 0} |`,
    '', '## Journeys', '',
  ];
  // Violations first and unmissable. A reader who stops after the summary must not
  // come away with the wrong conclusion.
  // A report with no violations FIELD is not the same as a report with no
  // violations. The first predates violation checking, so its authorization status
  // is unknown and must not read as clean: that is the same fail-open shape as a
  // signature check that skipped the chain.
  const violations = Array.isArray(r.violations) ? r.violations : null;
  if (violations === null) {
    lines.push('## ⚠ AUTHORIZATION STATUS UNKNOWN', '');
    lines.push('This report carries no `violations` field, so it was produced before');
    lines.push('authorization invariants were checked. Chain integrity says nothing about');
    lines.push('whether an action executed after being denied. Do not read this as clean.');
    lines.push('');
  } else if (violations.length > 0) {
    lines.push('## ⚠ AUTHORIZATION VIOLATIONS', '');
    lines.push('This run is NOT clean. The hash chain is intact, which means the ledger');
    lines.push('faithfully recorded the following governance failures:', '');
    for (const v of violations) {
      lines.push(`- **${v.kind}** (${v.requestId}): ${v.detail}`);
    }
    lines.push('');
  }

  for (const j of journeys) {
    lines.push(`### ${j.requestId}`, '');
    lines.push(`- **action:** ${j.actionKind} → \`${j.target}\``);
    lines.push(`- **path:** ${j.path}  **ruleId:** ${j.ruleId}`);
    // `executed` is stated on EVERY journey, never omitted. It used to be absent
    // entirely, so a journey that was denied and executed anyway rendered as a clean
    // "denied" and the reader concluded the action had been blocked.
    lines.push(`- **executed:** ${j.executed ? 'yes' : 'no'}`);
    if (j.executed && j.path === 'denied') {
      lines.push('- **⚠ VIOLATION:** executed despite a denied verdict');
    }
    // Both of the next two blocks state a weaker-than-ideal result out loud rather than
    // omitting it. An omitted line reads as "fine" to every reader, which is the same
    // fail-open shape as the missing violations field handled above.
    if (j.contextBinding !== undefined) {
      const said = {
        bound: 'yes: policy.evaluated binds the context it evaluated',
        unbound: 'NO: context recorded but no contextHash, so the verdict is not re-derivable from the ledger alone',
        mismatch: '⚠ MISMATCH: the recorded context is not what policy.evaluated says was evaluated',
      }[j.contextBinding];
      lines.push(`- **context bound:** ${said}`);
    }
    if (j.trajectory) {
      const t = j.trajectory;
      lines.push(
        t.state === 'proven'
          ? `- **trajectory:** inputs proven · root \`${t.inputsRoot}\` over ${t.leafCount} inputs`
          : `- **trajectory:** UNPROVEN · attested root \`${t.inputsRoot}\` over ${t.leafCount} inputs${t.reason ? ` · ${t.reason}` : ''}`,
      );
    }
    if (j.reviewRef) lines.push(`- **reviewRef:** ${j.reviewRef}`);
    if (j.attestedBy) lines.push(`- **attestedBy:** ${j.attestedBy}`);
    if (j.outcome) lines.push(`- **outcome:** ${j.outcome}`);
    lines.push('');
  }
  return lines.join('\n');
}
