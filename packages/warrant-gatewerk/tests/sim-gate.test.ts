// portfolio/packages/warrant-gatewerk/tests/sim-gate.test.ts
import { describe, it, expect } from 'vitest';
import { SimGate } from '../src/sim-gate.js';
import type { ReviewContent, ReviewRequest, ReviewDecision } from '../src/types.js';

const req = (n: number): ReviewRequest => ({
  requestId: `req-${n}`, runId: 'run-1', title: `T${n}`,
  content: { subject: `Subject ${n}`, body: `Body ${n}`, to: `a${n}@b.com` },
  metadata: { paramsHash: 'b'.repeat(64), stakesRuleId: 'cold-email' },
});

// The email edit lives HERE, in the test that means it, not in SimGate: the
// simulator carries the script, the caller carries the domain.
const appendToBody = (c: ReviewContent): ReviewContent => ({
  ...c, body: `${String(c['body'])}\n\n[edited in review]`,
});

describe('SimGate', () => {
  it('assigns reviewId sim-<n> in order', async () => {
    const g = new SimGate(['approve', 'edit', 'reject'], { editContent: appendToBody });
    expect((await g.submit(req(1))).data?.reviewId).toBe('sim-0');
    expect((await g.submit(req(2))).data?.reviewId).toBe('sim-1');
    expect((await g.submit(req(3))).data?.reviewId).toBe('sim-2');
  });

  it('fetchDecision: approve → approved', async () => {
    const g = new SimGate(['approve']);
    const s = await g.submit(req(1));
    expect(((await g.fetchDecision(s.data!.reviewId)).data as ReviewDecision).decision).toBe('approved');
  });

  it('fetchDecision: edit → editedContent is exactly what editContent returned', async () => {
    const g = new SimGate(['edit'], { editContent: appendToBody });
    const s = await g.submit(req(1));
    const d = (await g.fetchDecision(s.data!.reviewId)).data as ReviewDecision;
    expect(d.decision).toBe('edited');
    expect(d.editedContent?.['body']).toBe('Body 1\n\n[edited in review]');
    expect(d.editedContent?.['subject']).toBe('Subject 1');
    expect(d.editedContent?.['to']).toBe('a1@b.com');
  });

  // The injected editor receives the submitted content and its return value
  // is passed through untouched. SimGate must not add, drop or rewrite a field;
  // it does not know what any of them mean.
  it('editContent receives the submitted content and its result passes through unchanged', async () => {
    let seen: ReviewContent | undefined;
    const g = new SimGate(['edit'], {
      editContent: (c) => { seen = c; return { anything: 1, at: 'all' }; },
    });
    const s = await g.submit(req(7));
    const d = (await g.fetchDecision(s.data!.reviewId)).data as ReviewDecision;
    expect(seen).toEqual({ subject: 'Subject 7', body: 'Body 7', to: 'a7@b.com' });
    expect(d.editedContent).toEqual({ anything: 1, at: 'all' });
  });

  // The refusal is at CONSTRUCTION. Deferring it to fetchDecision would surface
  // the wiring mistake inside the code under test, several awaits from its cause.
  it("refuses at construction when the script says 'edit' with no editContent", () => {
    expect(() => new SimGate(['approve', 'edit'])).toThrow(/editContent/);
  });

  it('a script with no edit entry needs no editContent', () => {
    expect(() => new SimGate(['approve', 'reject'])).not.toThrow();
  });

  it('fetchDecision: reject → rejected', async () => {
    const g = new SimGate(['reject']);
    const s = await g.submit(req(1));
    expect(((await g.fetchDecision(s.data!.reviewId)).data as ReviewDecision).decision).toBe('rejected');
  });

  it('unknown reviewId → err gatewerk_api_error', async () => {
    expect((await new SimGate([]).fetchDecision('sim-999')).error?.code).toBe('gatewerk_api_error');
  });

  it('out-of-bounds script index defaults to approve', async () => {
    const g = new SimGate(['reject']); // length 1
    await g.submit(req(1));            // idx 0 → reject
    const s2 = await g.submit(req(2)); // idx 1 → default approve
    expect(((await g.fetchDecision(s2.data!.reviewId)).data as ReviewDecision).decision).toBe('approved');
  });
});
