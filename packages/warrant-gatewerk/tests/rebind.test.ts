// portfolio/packages/warrant-gatewerk/tests/rebind.test.ts
import { describe, it, expect } from 'vitest';
import { rebindParamsForEdit } from '../src/rebind.js';
import type { ReviewDecision } from '../src/types.js';

describe('rebindParamsForEdit', () => {
  it('returns editedContent in place of originalParams', () => {
    const decision: ReviewDecision = {
      reviewId: 'rv-1', decision: 'edited', decidedBy: 'alice@acme.com',
      editedContent: { subject: 'New subject', body: 'New body', to: 'new@x.com' },
    };
    const orig = { to: 'old@x.com', subject: 'Old', body: 'Old body' };
    const result = rebindParamsForEdit(decision, orig);
    expect(result).toEqual({ subject: 'New subject', body: 'New body', to: 'new@x.com' });
  });

  it('returns original params unchanged when decision has no editedContent', () => {
    const decision: ReviewDecision = { reviewId: 'rv-2', decision: 'approved', decidedBy: 'alice@acme.com' };
    const orig = { to: 'a@b.com', subject: 'S', body: 'B' };
    const result = rebindParamsForEdit(decision, orig);
    expect(result).toEqual(orig);
    // must be a copy, not the same reference
    expect(result).not.toBe(orig);
  });

  it('a resubmitted full payload yields exactly that payload', () => {
    const decision: ReviewDecision = {
      reviewId: 'rv-3', decision: 'edited', decidedBy: 'alice@acme.com',
      editedContent: { subject: 'Only subject changed', body: 'Original body', to: 'a@b.com' },
    };
    const orig = { to: 'a@b.com', subject: 'Old subject', body: 'Original body' };
    const result = rebindParamsForEdit(decision, orig);
    expect(result['subject']).toBe('Only subject changed');
    expect(result['body']).toBe('Original body');
    expect(result['to']).toBe('a@b.com');
  });

  // `rebindParamsForEdit` REPLACES: a key present in originalParams and absent
  // from editedContent is GONE, not back-filled. That is the fail-closed direction:
  // the caller's shape guard then rejects the partial, where a merge would hand on
  // a combination no human reviewed as a whole.
  it('replaces rather than merges: a key absent from editedContent is dropped', () => {
    const decision: ReviewDecision = {
      reviewId: 'rv-5', decision: 'edited', decidedBy: 'alice@acme.com',
      editedContent: { body: 'Only the body came back' },
    };
    const orig = { to: 'a@b.com', subject: 'S', body: 'B', cc: 'c@d.com' };
    const result = rebindParamsForEdit(decision, orig);
    expect(result).toEqual({ body: 'Only the body came back' });
    expect(result['to']).toBeUndefined();
    expect(result['cc']).toBeUndefined();
  });

  // Field-blind: nothing here knows what an email is.
  it('carries a content shape it has never seen', () => {
    const decision: ReviewDecision = {
      reviewId: 'rv-6', decision: 'edited', decidedBy: 'alice@acme.com',
      editedContent: { headline: 'H', bullets: ['a', 'b'], budgetCents: 4200 },
    };
    const result = rebindParamsForEdit(decision, { headline: 'old', bullets: [], budgetCents: 0 });
    expect(result).toEqual({ headline: 'H', bullets: ['a', 'b'], budgetCents: 4200 });
  });

  it('does not mutate originalParams', () => {
    const decision: ReviewDecision = {
      reviewId: 'rv-4', decision: 'edited', decidedBy: 'alice@acme.com',
      editedContent: { subject: 'X', body: 'Y', to: 'z@z.com' },
    };
    const orig = { to: 'a@b.com', subject: 'S', body: 'B' };
    const frozen = Object.freeze({ ...orig });
    const result = rebindParamsForEdit(decision, frozen);
    expect(result.subject).toBe('X');
    expect(frozen.subject).toBe('S');
  });
});
