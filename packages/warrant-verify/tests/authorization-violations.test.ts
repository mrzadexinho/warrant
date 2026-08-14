// Chain integrity and authorization are different questions, and only the first was
// ever checked.
//
// A run in which policy DENIED an action and the action executed anyway has a
// perfectly intact hash chain: every entry links correctly, because the ledger
// faithfully recorded a governance failure. replayRun verified that chain and
// reported the run clean, and renderProofMarkdown never printed `executed` on a
// journey at all, so the certificate rendered a denied-and-executed action as a
// tidy "denied" and the reader concluded it had been blocked.
//
// That is a certificate asserting the opposite of what the ledger says, which is the
// only defect class that actually matters for this product.
import { describe, it, expect } from 'vitest';
import { GENESIS_PREV_HASH, entryHash } from '@idriszade/warrant-ledger';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { replayRun } from '../src/replay.js';
import { renderProofMarkdown } from '../src/render.js';

const P = { kind: 'agent' as const, id: 'a' };
const NOW = () => new Date('2026-07-27T00:00:00.000Z');

/** A run where policy denied the action and the action executed anyway. */
function deniedThenExecuted(): LedgerEntry[] {
  const mk = (seq: number, prevHash: string, event: LedgerEntry['event'], payload: unknown) => {
    const b = { seq, prevHash, runId: 'run-x', at: `2026-07-27T00:0${seq}:00Z`, event, principal: P, payload };
    return { ...b, hash: entryHash(b) };
  };
  const e1 = mk(1, GENESIS_PREV_HASH, 'warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ceo@competitor.gov' });
  const e2 = mk(2, e1.hash, 'policy.evaluated', { requestId: 'r1', ruleId: 'protected-audience', path: 'deny' });
  const e3 = mk(3, e2.hash, 'warrant.denied', { requestId: 'r1', reason: 'policy_denied:protected-audience' });
  // The governance failure: executed anyway.
  const e4 = mk(4, e3.hash, 'action.executed', { requestId: 'r1', warrantId: 'w-ghost', nonce: 'n-1' });
  return [e1, e2, e3, e4];
}

describe('replayRun reports authorization violations, not just chain integrity', () => {
  it('a denied action that executed is flagged, even though the chain is intact', () => {
    const r = replayRun(deniedThenExecuted(), 'run-x', NOW);
    // The chain really is fine. That is the whole point: chain integrity does not
    // imply the run was authorized.
    expect(r.error).toBeNull();
    expect(r.data!.chainVerified).toBe(true);
    expect(r.data!.violations.map((v) => v.kind)).toContain('executed_after_deny');
    expect(r.data!.violations[0]!.requestId).toBe('r1');
  });

  it('the rendered certificate states executed on the journey and flags the violation', () => {
    const md = renderProofMarkdown(replayRun(deniedThenExecuted(), 'run-x', NOW).data!);
    expect(md).toMatch(/AUTHORIZATION VIOLATIONS/);
    expect(md).toMatch(/executed_after_deny/);
    // The per-journey line is what a reader actually scans. Its absence is how the
    // original defect hid: the aggregate count was present but nothing said WHICH
    // journey executed.
    expect(md).toMatch(/\*\*executed:\*\* yes/);
    expect(md).toMatch(/VIOLATION.*denied verdict/);
  });

  it('a clean run has no violations and renders none', () => {
    // The positive case. Without it, a change that flagged every run would satisfy
    // every assertion above.
    const mk = (seq: number, prevHash: string, event: LedgerEntry['event'], payload: unknown) => {
      const b = { seq, prevHash, runId: 'run-ok', at: `2026-07-27T00:0${seq}:00Z`, event, principal: P, payload };
      return { ...b, hash: entryHash(b) };
    };
    const e1 = mk(1, GENESIS_PREV_HASH, 'warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' });
    const e2 = mk(2, e1.hash, 'policy.evaluated', { requestId: 'r1', ruleId: 'known-audience', path: 'auto' });
    const e3 = mk(3, e2.hash, 'warrant.issued', { requestId: 'r1', warrantId: 'w-1' });
    const e4 = mk(4, e3.hash, 'action.executed', { requestId: 'r1', warrantId: 'w-1', nonce: 'n-1' });
    const r = replayRun([e1, e2, e3, e4], 'run-ok', NOW);
    expect(r.data!.violations).toEqual([]);
    const md = renderProofMarkdown(r.data!);
    expect(md).not.toMatch(/AUTHORIZATION VIOLATIONS/);
    expect(md).toMatch(/\*\*executed:\*\* yes/);
  });

  it('a report with no violations field renders as UNKNOWN, never as clean', () => {
    // A report predating violation checking must not read as clean: that is the same
    // fail-open shape as a signature check that skipped the chain.
    const r = replayRun(deniedThenExecuted(), 'run-x', NOW).data!;
    const legacy = { ...r, violations: undefined } as unknown as typeof r;
    const md = renderProofMarkdown(legacy);
    expect(md).toMatch(/AUTHORIZATION STATUS UNKNOWN/);
    expect(md).toMatch(/Do not read this as clean/);
  });
});
