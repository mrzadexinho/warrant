// Guards in src/chain.ts and src/replay.ts that a mutation sweep found unheld.
//
// These are the two files that decide what a certificate SAYS. chain.ts decides whether
// the evidence is intact; replay.ts turns the evidence into the journeys and counts a
// reader actually looks at. A guard that stops existing in replay.ts does not break
// anything visibly: it produces a certificate that is well-formed, verified, and
// describing something that did not happen.
//
// Each test was checked by re-deleting its guard and confirming this test then fails,
// with the deletion diffed to prove it applied.
//
// Two survivors from this package are REDUNDANT and are deliberately not given tests
// that cannot fail:
//   replay.ts's `if (reqId) warrantToRequest.set(wId, reqId)`. Without the condition the
//   map stores undefined for that key, `get(wId)` returns undefined either way, and the
//   `?? \`warrant:${wId}\`` fallback below produces the identical key. No input
//   distinguishes it.
//   intoto.ts's `typeof sha256 !== 'string'` changes only the message, since a non-string
//   sha256 fails the digest comparison one line down regardless. That message IS the
//   guard's contribution, so it is pinned in intoto.test.ts rather than left here.
import { describe, it, expect } from 'vitest';
import { MemoryLedger, entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { verifyChain } from '../src/chain.js';
import { replayRun } from '../src/replay.js';

const P = { kind: 'agent' as const, id: 'a' };
const NOW = () => new Date('2026-07-27T12:00:00.000Z');

/** Builds a chain-valid run through the real ledger, so hashes are never hand-faked. */
async function chainOf(
  runId: string,
  events: Array<[LedgerEntry['event'], unknown, { principal?: LedgerEntry['principal'] }?]>,
  seed?: MemoryLedger,
): Promise<{ ledger: MemoryLedger; entries: LedgerEntry[] }> {
  const l = seed ?? new MemoryLedger();
  let t = 0;
  for (const [event, payload, opts] of events) {
    const r = await l.append({
      runId, at: `2026-07-27T0${t < 10 ? '0' : ''}:${String(t++).padStart(2, '0')}:00.000Z`,
      event, principal: opts?.principal ?? P, payload,
    });
    if (r.error) throw new Error(`fixture append failed: ${r.error.message}`);
  }
  return { ledger: l, entries: (await l.readAll()).data! };
}

describe('verifyChain anchors the chain at GENESIS', () => {
  it('a chain whose first entry links to something other than GENESIS is broken', async () => {
    // `expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i-1].hash` is the only place
    // the chain is tied to a fixed starting point. Delete it and entry 0's prevHash is
    // whatever it says it is, so a chain that begins in the middle of another chain, or
    // at a fabricated ancestor, verifies as complete. Entry 0's own hash covers its
    // prevHash, so a forger recomputing it does not trip the content check either:
    // this guard is the entire difference.
    const { entries } = await chainOf('run-1', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known', path: 'auto' }],
    ]);
    expect(verifyChain(entries).error).toBeNull();

    // Re-anchor entry 0 to a fabricated ancestor and recompute every hash forward, so
    // the result is internally consistent in every respect EXCEPT its starting point.
    const head = { ...entries[0]!, prevHash: 'ab'.repeat(32) };
    head.hash = entryHash({
      seq: head.seq, prevHash: head.prevHash, runId: head.runId,
      at: head.at, event: head.event, principal: head.principal, payload: head.payload,
    });
    const next = { ...entries[1]!, prevHash: head.hash };
    next.hash = entryHash({
      seq: next.seq, prevHash: next.prevHash, runId: next.runId,
      at: next.at, event: next.event, principal: next.principal, payload: next.payload,
    });

    const r = verifyChain([head, next]);

    expect(r.error?.code).toBe('chain_broken');
    // The premise, asserted rather than assumed: the forgery really is self-consistent,
    // so the rejection can only come from the GENESIS anchor.
    expect(head.hash).toBe(entryHash({
      seq: head.seq, prevHash: head.prevHash, runId: head.runId,
      at: head.at, event: head.event, principal: head.principal, payload: head.payload,
    }));
    expect(next.prevHash).toBe(head.hash);
  });

  it('an entry that cannot be canonicalised is chain_broken, never a thrown exception', () => {
    // verifyChain is an exported library function and its contract says it never throws.
    // Entries loaded from JSON cannot carry a BigInt, but a consumer building
    // LedgerEntry[] in memory can, and warrant-eve calls verifyChain on exactly such a
    // list before every resume. Without the try/catch the throw escapes into
    // resumeByPoll's outer catch and a chain integrity failure is reported as
    // resume_internal_error.
    const bad = [{
      seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r', at: '2026-07-27T00:00:00.000Z',
      event: 'warrant.requested', principal: P,
      payload: { amount: 1n },
      hash: 'f'.repeat(64),
    } as unknown as LedgerEntry];

    expect(() => verifyChain(bad)).not.toThrow();
    const r = verifyChain(bad);
    expect(r.error?.code).toBe('chain_broken');
    expect(r.error?.message).toMatch(/cannot canonicalize/);
  });

  it('a genuine chain still verifies, so neither check is rejecting everything', async () => {
    const { entries } = await chainOf('run-1', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known', path: 'auto' }],
    ]);
    expect(verifyChain(entries).data).toBe(true);
  });
});

describe('replayRun reports the run it was asked about, and only that run', () => {
  it('journeys and counts exclude every other run in the same ledger', async () => {
    // One ledger file routinely holds many runs: the CLI loops over every runId it
    // finds. Without the filter, a certificate for run-a folds in run-b's journeys and
    // counts, so a clean run inherits another run's actions and a reader attributes
    // them to the wrong session. Nothing about the document looks wrong.
    const first = await chainOf('run-a', [
      ['warrant.requested', { requestId: 'a1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'a1', ruleId: 'known', path: 'auto' }],
      ['warrant.issued', { requestId: 'a1', warrantId: 'w-a1' }],
      ['action.executed', { requestId: 'a1', warrantId: 'w-a1', nonce: 'n-1' }],
    ]);
    const both = await chainOf('run-b', [
      ['warrant.requested', { requestId: 'b1', actionKind: 'send_email', target: 'other@acme.com' }],
      ['policy.evaluated', { requestId: 'b1', ruleId: 'known', path: 'auto' }],
      ['warrant.issued', { requestId: 'b1', warrantId: 'w-b1' }],
      ['action.executed', { requestId: 'b1', warrantId: 'w-b1', nonce: 'n-2' }],
    ], first.ledger);

    const r = replayRun(both.entries, 'run-a', NOW);

    expect(r.error).toBeNull();
    expect(r.data!.journeys.map((j) => j.requestId)).toEqual(['a1']);
    expect(r.data!.counts).toMatchObject({ requested: 1, executed: 1 });
    expect(r.data!.journeys.map((j) => j.target)).not.toContain('other@acme.com');
  });

  it('a review.decided with no requestId does not invent a request', async () => {
    // getRequested adds its key to the request-backed set, which is what counts.requested
    // is derived from. Calling it unconditionally for a review.decided that carries no
    // requestId creates a journey keyed '__unknown__' and counts it as a request, so the
    // certificate's headline number reports one more request than the run made.
    const { entries } = await chainOf('run-c', [
      ['warrant.requested', { requestId: 'c1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'c1', ruleId: 'cold', path: 'human' }],
      ['review.submitted', { requestId: 'c1', reviewId: 'rv-1' }],
      ['review.decided', { reviewId: 'rv-1', decision: 'approved', decidedBy: 'reviewer:erin' }],
    ]);

    const r = replayRun(entries, 'run-c', NOW);

    expect(r.error).toBeNull();
    expect(r.data!.counts.requested).toBe(1);
    expect(r.data!.journeys.map((j) => j.requestId)).toEqual(['c1']);
  });

  it('attestedBy names the principal that appended the attestation, not a payload field', async () => {
    // The attestation is the certificate's claim about WHO signed off. Reading it from
    // the payload would take the name from a field any writer can set to anything;
    // reading it from the entry's principal takes it from the ledger's own record of
    // the appending identity, which is the field markSent populates from the operator
    // and which the hash chain covers as part of the entry.
    const { entries } = await chainOf('run-d', [
      ['warrant.requested', { requestId: 'd1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'd1', ruleId: 'known', path: 'auto' }],
      ['warrant.issued', { requestId: 'd1', warrantId: 'w-d1' }],
      ['action.executed', { requestId: 'd1', warrantId: 'w-d1', nonce: 'n-1' }],
      // The payload names somebody else entirely. It must be ignored.
      ['operator.attested', { warrantId: 'w-d1', step: 'sent', attestedBy: 'mallory' },
        { principal: { kind: 'human' as const, id: 'alice' } }],
    ]);

    const r = replayRun(entries, 'run-d', NOW);

    const journey = r.data!.journeys.find((j) => j.requestId === 'd1');
    expect(journey?.attestedBy).toBe('alice');
    expect(journey?.attestedBy).not.toBe('mallory');
    expect(r.data!.counts.attested).toBe(1);
  });
});

// ── Orphaned entries are surfaced, never folded into a shared journey ─────────────────────────
//
// The guard above (`a review.decided with no requestId does not invent a request`) named this
// failure and fixed exactly one branch. Its five neighbours kept `reqId ?? '__unknown__'`, so
// every id-less entry landed in ONE shared journey and entries from unrelated actions merged
// into a fabricated one. Two consequences are traced in `RunViolation.kind`; both are pinned
// below. Each test was checked by restoring `?? '__unknown__'` and confirming it then fails.
describe('replay.ts: an entry with no usable id is a violation, not a journey', () => {
  it('THE SUPPRESSION CASE: an id-less warrant.issued must not hide an unwarranted execution', async () => {
    // Before the fix: warrant.issued keyed '__unknown__' set that journey's warrantId WITHOUT
    // populating the correlation map, so action.executed resolved to the same shared object and
    // found a warrantId there, and executed_without_warrant never fired.
    const { entries } = await chainOf('run-o1', [
      ['warrant.issued', { warrantId: 'w-1', warrant: {} }],
      ['action.executed', { warrantId: 'w-1', nonce: 'n-1' }],
    ]);

    const r = replayRun(entries, 'run-o1', NOW);

    expect(r.error).toBeNull();
    const kinds = r.data!.violations.map((v) => v.kind);
    // The entry is reported rather than absorbed...
    expect(kinds).toContain('orphaned_entry');
    // ...and no journey claims a warrant it cannot trace to a request.
    expect(r.data!.journeys.map((j) => j.requestId)).not.toContain('__unknown__');
    expect(r.data!.counts.requested).toBe(0);
  });

  it('an id-less warrant.denied cannot poison an unrelated journey', async () => {
    // Before the fix: warrant.denied set path='denied' on the shared journey, so one id-less
    // denial could make executed_after_deny fire against the wrong action, or mask a real one.
    const { entries } = await chainOf('run-o2', [
      ['warrant.requested', { requestId: 'd1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'd1', ruleId: 'cold', path: 'auto' }],
      ['warrant.denied', { reason: 'policy_denied:something' }],
    ]);

    const r = replayRun(entries, 'run-o2', NOW);

    expect(r.error).toBeNull();
    expect(r.data!.violations.map((v) => v.kind)).toContain('orphaned_entry');
    // The real journey keeps its own verdict.
    expect(r.data!.journeys.find((j) => j.requestId === 'd1')!.path).toBe('auto');
    expect(r.data!.counts.denied).toBe(0);
  });

  it('two id-less entries from unrelated actions do not merge into one journey', async () => {
    const { entries } = await chainOf('run-o3', [
      ['warrant.requested', { actionKind: 'send_email', target: 'a@acme.com' }],
      ['warrant.requested', { actionKind: 'send_email', target: 'b@acme.com' }],
    ]);

    const r = replayRun(entries, 'run-o3', NOW);

    expect(r.error).toBeNull();
    // Two entries, two violations: not one journey wearing the second one's target.
    expect(r.data!.violations.filter((v) => v.kind === 'orphaned_entry')).toHaveLength(2);
    expect(r.data!.journeys).toHaveLength(0);
    expect(r.data!.journeys.map((j) => j.target)).not.toContain('b@acme.com');
  });

  it('an empty-string requestId is absent, not a key', async () => {
    const { entries } = await chainOf('run-o4', [
      ['warrant.requested', { requestId: '', actionKind: 'send_email', target: 'ok@acme.com' }],
    ]);

    const r = replayRun(entries, 'run-o4', NOW);
    expect(r.data!.violations.map((v) => v.kind)).toEqual(['orphaned_entry']);
    expect(r.data!.journeys).toHaveLength(0);
  });

  it('NOT VACUOUS: a conforming run reports no orphans and is unchanged by this guard', async () => {
    // The whole change must be a no-op on any ledger warrant actually wrote. Without this, the
    // four tests above would pass on a replay that flagged everything.
    const { entries } = await chainOf('run-o5', [
      ['warrant.requested', { requestId: 'k1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'k1', ruleId: 'cold', path: 'auto' }],
      ['warrant.issued', { requestId: 'k1', warrantId: 'w-9', warrant: {} }],
      ['action.executed', { warrantId: 'w-9', nonce: 'n-9' }],
      ['action.outcome', { warrantId: 'w-9', status: 'executed' }],
    ]);

    const r = replayRun(entries, 'run-o5', NOW);

    expect(r.error).toBeNull();
    expect(r.data!.violations).toEqual([]);
    expect(r.data!.counts.requested).toBe(1);
    expect(r.data!.counts.executed).toBe(1);
    // action.executed / action.outcome still resolve through the correlation map, which is the
    // path a warrantId-only event is SUPPOSED to take.
    expect(r.data!.journeys.map((j) => j.requestId)).toEqual(['k1']);
  });
});
