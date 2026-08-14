// A bare `catch { swallow }` in `tryDeliver` would be wrong: a duplicate resume genuinely throws,
// but the same bare catch would also absorb "session not found", which is a STALLED RUN, and the
// two would be indistinguishable from every vantage point: the warrant mints, the webhook handler
// returns 200, Gatewerk records `delivered`, the outbox stays empty, and nothing anywhere says why.
//
// This is the test that stops it regressing to silence. It asserts the observable that was missing,
// not the control flow, which is deliberately unchanged, because the ledger already holds the
// decision and the mint by the time `deliver` runs.
import { describe, it, expect, vi } from 'vitest';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { resumeByPoll } from '../src/resume.js';
import { SESSION_ID, makeDeps, seedReview } from './fixtures.js';

const INPUT = { to: 'vp@acme.test', subject: 'S', body: 'B', audience: 'cold' as const };

describe('resumeByPoll: a failed wake-up is reported, never swallowed', () => {
  it('calls onDeliverError with the thrown error when deliver fails', async () => {
    const deliverError = new Error('Cannot deliver inputResponses: the target session was not found');
    const seen: Array<{ site: string; outcome: string; error: unknown }> = [];
    const deps = makeDeps({ gate: new SimGate(['approve']), onDeliverError: (i) => { seen.push(i); } });
    const reviewId = await seedReview(deps, INPUT);

    const r = await resumeByPoll(deps, {
      reviewId, runId: SESSION_ID,
      deliver: async () => { throw deliverError; },
    });

    // Control flow unchanged: the mint still succeeds and is still reported as issued, because the
    // ledger, not the runtime wake-up, is authoritative about what was authorized.
    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');

    // The observable that did not exist before.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.error).toBe(deliverError);
    expect(seen[0]!.outcome).toBe('approved');
    expect(typeof seen[0]!.site).toBe('string');
    expect(seen[0]!.site.length).toBeGreaterThan(0);
  });

  it('does not report when deliver succeeds', async () => {
    const seen: unknown[] = [];
    const deps = makeDeps({ gate: new SimGate(['approve']), onDeliverError: (i) => { seen.push(i); } });
    const reviewId = await seedReview(deps, INPUT);

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });

    expect(r.data).toBe('issued');
    expect(seen).toHaveLength(0);
  });

  // Without a wired reporter the failure must still surface. A caller who configures nothing was
  // exactly the caller who lost three hours to this.
  it('falls back to console.error rather than silence when no reporter is wired', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps({ gate: new SimGate(['approve']) });
      const reviewId = await seedReview(deps, INPUT);
      await resumeByPoll(deps, {
        reviewId, runId: SESSION_ID,
        deliver: async () => { throw new Error('session not found'); },
      });
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0]![0])).toContain('deliver failed');
      expect(String(spy.mock.calls[0]![0])).toContain('session not found');
    } finally { spy.mockRestore(); }
  });

  // A reporter that throws must not break a resume whose ledger half already succeeded.
  it('survives a reporter that itself throws', async () => {
    const deps = makeDeps({
      gate: new SimGate(['approve']),
      onDeliverError: () => { throw new Error('reporter exploded'); },
    });
    const reviewId = await seedReview(deps, INPUT);

    const r = await resumeByPoll(deps, {
      reviewId, runId: SESSION_ID,
      deliver: async () => { throw new Error('session not found'); },
    });

    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
  });
});
