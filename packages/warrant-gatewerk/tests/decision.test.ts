// portfolio/packages/warrant-gatewerk/tests/decision.test.ts
//
// C7 table, one test per row, plus the guard's required negative/positive
// battery and the ordering-correctness tests for the false-attestation hole
// (spec 2.2). See src/decision.ts for the isSystemDecider rationale.
import { describe, it, expect } from 'vitest';
import { mapReviewDecision } from '../src/decision.js';
import pending from './fixtures/review-pending.json' with { type: 'json' };
import approved from './fixtures/review-decided-approved.json' with { type: 'json' };
import edited from './fixtures/review-decided-edited.json' with { type: 'json' };
import systemDecided from './fixtures/review-decided-system.json' with { type: 'json' };
import systemMaxIterations from './fixtures/review-decided-system-max-iterations.json' with { type: 'json' };

describe('mapReviewDecision: C7 table', () => {
  it.each(['pending', 'awaiting_iteration', 'awaiting_external', 'monitoring'])(
    'status %s: ok pending',
    (status) => {
      expect(mapReviewDecision({ ...pending, status }).data).toEqual({ pending: true });
    },
  );

  it.each(['expired', 'archived'])(
    'terminal status %s (no decision): rejected, decidedBy system:%s (the one place a system decider is allowed, because it denies)',
    (status) => {
      expect(mapReviewDecision({ ...pending, status, decision: null, decided_by: null }).data).toEqual({
        reviewId: pending.id,
        decision: 'rejected',
        decidedBy: `system:${status}`,
      });
    },
  );

  it('decided + approved, human decided_by: ok approved', () => {
    expect(mapReviewDecision(approved).data).toEqual({
      reviewId: approved.id,
      decision: 'approved',
      decidedBy: approved.decided_by,
    });
  });

  it('decided + edited with edited_payload: ok edited, editedContent from edited_payload', () => {
    expect(mapReviewDecision(edited).data).toEqual({
      reviewId: edited.id,
      decision: 'edited',
      editedContent: edited.edited_payload,
      decidedBy: edited.decided_by,
    });
  });

  it('decided + edited, no edited_payload: err edited_no_content', () => {
    expect(mapReviewDecision({ ...edited, edited_payload: null }).error?.code).toBe('edited_no_content');
  });

  it.each(['rejected', 'vetoed', 'max_iterations_reached', 'expired'])(
    'decided + decision %s (human): ok rejected',
    (decision) => {
      expect(mapReviewDecision({ ...approved, decision, decided_by: 'alice@acme.com' }).data).toEqual({
        reviewId: approved.id,
        decision: 'rejected',
        decidedBy: 'alice@acme.com',
      });
    },
  );

  it.each(['retried', 'confirmed'])('decided + decision %s: err unrecognized_decision', (decision) => {
    expect(mapReviewDecision({ ...approved, decision, decided_by: 'alice@acme.com' }).error?.code).toBe(
      'unrecognized_decision',
    );
  });

  it('unknown status: err unrecognized_status', () => {
    const r = mapReviewDecision({ ...pending, status: 'frobnicate' });
    expect(r.error?.code).toBe('unrecognized_status');
  });

  it.each([null, 'a string', 42, true, ['array', 'not', 'object']])(
    'input %j that is not a plain object: err unrecognized_status',
    (input) => {
      expect(mapReviewDecision(input).error?.code).toBe('unrecognized_status');
    },
  );

  it('the system-timeout fixture (§2.2 false-attestation hole) is rejected, never minted', () => {
    expect(mapReviewDecision(systemDecided).error?.code).toBe('human_attestation_missing');
  });
});

describe('mapReviewDecision: human-attestation guard, decider normalization', () => {
  it.each([
    undefined,
    null,
    '',
    '   ',
    '\t\n',
    'system:timeout',
    ' system:timeout',
    'system:monitoring_window',
    'System:timeout',
    'SYSTEM:timeout',
  ])('decided_by %j on decided+approved: err human_attestation_missing', (decidedBy) => {
    expect(mapReviewDecision({ ...approved, decided_by: decidedBy }).error?.code).toBe('human_attestation_missing');
  });

  it('a real human identity with decision approved reaches a mintable ok (the guard is not always-on)', () => {
    const r = mapReviewDecision({ ...approved, decided_by: 'idris@example.com' });
    expect(r.data).toEqual({ reviewId: approved.id, decision: 'approved', decidedBy: 'idris@example.com' });
  });
});

describe('mapReviewDecision: decider checked before the decision branch', () => {
  it(
    'real Gatewerk closeMaxIterations shape: decision max_iterations_reached (otherwise a valid human ' +
      'rejection value) + decided_by system:max_iterations: err human_attestation_missing, NOT ok rejected',
    () => {
      const r = mapReviewDecision(systemMaxIterations);
      expect(r.error?.code).toBe('human_attestation_missing');
      expect(r.data).toBeFalsy();
    },
  );

  it('system decider is rejected regardless of decision value: approved, edited (with edited_payload), and rejected all deny', () => {
    for (const decision of ['approved', 'edited', 'rejected']) {
      const r = mapReviewDecision({ ...edited, decision, decided_by: 'system:timeout' });
      expect(r.error?.code).toBe('human_attestation_missing');
    }
  });
});

describe('mapReviewDecision: system/auto-approve bypass (found via source verification, not in the plan draft)', () => {
  it(
    "gatewerk/apps/api/src/services/reviews/crud.ts's per-template auto_approve path writes " +
      "decided_by:'system/auto-approve' (slash, not colon) at review CREATE time when the template has " +
      "auto_approve:true and oversight isn't 'monitoring'. This is not something submit() (C6) controls: " +
      'it is a server-side template setting. err human_attestation_missing, never a mintable approval.',
    () => {
      const r = mapReviewDecision({ ...approved, decided_by: 'system/auto-approve' });
      expect(r.error?.code).toBe('human_attestation_missing');
    },
  );

  it('case and whitespace variants of the slash form are also rejected', () => {
    for (const decidedBy of ['SYSTEM/auto-approve', ' system/auto-approve', 'System/Auto-Approve']) {
      expect(mapReviewDecision({ ...approved, decided_by: decidedBy }).error?.code).toBe('human_attestation_missing');
    }
  });
});

describe('mapReviewDecision: guard widened past the two observed separators', () => {
  // Enumerating ':' and '/' is a denylist of what Gatewerk happens to write today.
  // These pin the widened /^system([^a-z0-9]|$)/i so the next separator Gatewerk
  // invents cannot reopen the hole without a test going red.
  for (const decided_by of ['system-auto', 'system.auto', 'system_auto', 'system auto', 'system']) {
    it(`rejects decided_by ${JSON.stringify(decided_by)} as a machine identity`, () => {
      const r = mapReviewDecision({ ...approved, decided_by });
      expect(r.error?.code).toBe('human_attestation_missing');
      expect(r.data).toBeNull();
    });
  }

  it('does NOT reject a human whose name merely begins with the letters "system"', () => {
    // The pattern requires a non-alphanumeric separator (or end of string) after
    // "system", so a real identity like this stays mintable. Without this case, a
    // guard that rejected every string starting with "system" would look correct
    // against all the negative cases above.
    const r = mapReviewDecision({ ...approved, decided_by: 'systema@corp.com' });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ decision: 'approved', decidedBy: 'systema@corp.com' });
  });
});

describe('mapReviewDecision: action_value is an independent second signal', () => {
  it('rejects a machine action_value even when decided_by is perfectly human', () => {
    // This is what proves the two signals are independent rather than redundant.
    // If the decider string were ever renamed away from a "system" prefix, this
    // check is what still denies. Source: crud.ts:227-229 writes decided_by AND
    // action_value:'auto_approve' in the same statement.
    const r = mapReviewDecision({ ...approved, decided_by: 'idris@example.com', action_value: 'auto_approve' });
    expect(r.error?.code).toBe('human_attestation_missing');
    expect(r.data).toBeNull();
  });

  it('rejects a machine action_value regardless of case or surrounding whitespace', () => {
    const r = mapReviewDecision({ ...approved, decided_by: 'idris@example.com', action_value: '  AUTO_APPROVE ' });
    expect(r.error?.code).toBe('human_attestation_missing');
  });

  it('leaves a genuine human decision with an ordinary action_value mintable', () => {
    const r = mapReviewDecision({ ...approved, decided_by: 'idris@example.com', action_value: 'approve' });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ decision: 'approved', decidedBy: 'idris@example.com' });
  });
});

describe('mapReviewDecision: human attestation is an allowlist on last_action_by', () => {
  // decided_by is spoofable and does not mark machine actors. Gatewerk's own
  // monitoring.ts:20-27 says so. These pin the allowlist that replaced it.

  it("rejects an API-key agent decision: decided_by is a bare key prefix with no machine marker", () => {
    // routes/reviews/action.ts:104 -> actor {kind:'agent', id: apiKeyPrefix}
    // services/reviews/actions.ts:217 -> decided_by = actor.id (RAW, unprefixed)
    // Every decided_by-based check accepts this. Only last_action_by exposes it.
    const r = mapReviewDecision({
      ...approved,
      decided_by: 'gwk_live_7f3a',
      last_action_by: 'agent:gwk_live_7f3a',
    });
    expect(r.error?.code).toBe('human_attestation_missing');
    expect(r.data).toBeNull();
  });

  it('rejects a spoofed human name supplied by an API-key caller via body.reviewer', () => {
    // routes/reviews/decide.ts:203-204 lets an agent actor overwrite decided_by
    // with any string. The agent that CREATED the review can approve it under a
    // fake human name. last_action_by still reports the real actor kind.
    const r = mapReviewDecision({
      ...approved,
      decided_by: 'alice@corp.example',
      last_action_by: 'agent:gwk_live_7f3a',
    });
    expect(r.error?.code).toBe('human_attestation_missing');
    expect(r.data).toBeNull();
  });

  it.each([null, undefined, '', '   ', 'reviewer:', 'chain:run_1', 'external:partner', 'REVIEWERX:a@b.c'])(
    'rejects last_action_by %p as not a human reviewer session',
    (last_action_by) => {
      const r = mapReviewDecision({ ...approved, decided_by: 'alice@acme.com', last_action_by });
      expect(r.error?.code).toBe('human_attestation_missing');
    },
  );

  it('accepts a genuine reviewer session, case-insensitively', () => {
    // The positive case. Without it the guard could be tightened into rejecting
    // everything and every negative test above would still pass.
    const r = mapReviewDecision({
      ...approved,
      decided_by: 'alice@acme.com',
      last_action_by: 'Reviewer:Alice@Acme.com',
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ decision: 'approved', decidedBy: 'alice@acme.com' });
  });

  it('accepts a genuine reviewer session that arrives with surrounding whitespace', () => {
    // isHumanAttested trims before matching, and nothing held that. Deleting the trim
    // turns a padded value into a rejection, so the only test that can see the trim is
    // a positive one: every negative case above passes either way.
    //
    // Worth knowing which direction this trim runs in. isSystemDecider trims for
    // fail-CLOSED reasons (' system:timeout' must still read as a machine). This one
    // trims in the fail-OPEN direction: it accepts a value the untrimmed comparison
    // would refuse. It is pinned here as the behaviour that exists, not endorsed.
    const r = mapReviewDecision({
      ...approved,
      decided_by: 'alice@acme.com',
      last_action_by: '  reviewer:alice@acme.com\t',
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ decision: 'approved', decidedBy: 'alice@acme.com' });
  });
});

describe('mapReviewDecision: approve-with-edits is how humans actually edit', () => {
  // Gatewerk's inbox sends decision:'approved' WITH edited_payload; no first-party
  // client ever sends decision:'edited'. Reading edits only under that value meant
  // the reviewer's corrections were dropped and the warrant was minted over the
  // original params, so the agent sent the content the human edited away, under a
  // certificate saying a human approved.
  const HUMAN = { decided_by: 'alice@acme.com', last_action_by: 'reviewer:alice@acme.com' };

  it("decision 'approved' carrying edited_payload surfaces the edits", () => {
    const r = mapReviewDecision({
      ...approved,
      ...HUMAN,
      decision: 'approved',
      edited_payload: { to: 'correct@corp.example', subject: 'S', body: 'B' },
    });
    expect(r.error).toBeNull();
    // Routed through 'edited' on purpose: that is the path that re-binds params and
    // re-runs policy on the final content before the warrant is issued.
    expect(r.data).toMatchObject({
      decision: 'edited',
      editedContent: { to: 'correct@corp.example', subject: 'S', body: 'B' },
      decidedBy: 'alice@acme.com',
    });
  });

  it("the recipient the human removed is NOT what gets authorized", () => {
    // The concrete harm, stated as a test: a reviewer redirects the email away
    // from a wrong address. Before this fix the original address survived.
    const r = mapReviewDecision({
      ...approved,
      ...HUMAN,
      decision: 'approved',
      edited_payload: { to: 'correct@corp.example', subject: 'S', body: 'B' },
    });
    const content = (r.data as { editedContent?: { to: string } }).editedContent;
    expect(content?.to).toBe('correct@corp.example');
    expect(content?.to).not.toBe('wrong@evil.example');
  });

  it("plain 'approved' with no edits stays a plain approval", () => {
    const r = mapReviewDecision({ ...approved, ...HUMAN, decision: 'approved' });
    expect(r.data).toMatchObject({ decision: 'approved', decidedBy: 'alice@acme.com' });
    expect((r.data as { editedContent?: unknown }).editedContent).toBeUndefined();
  });

  it("an EMPTY edited_payload is not an edit", () => {
    // Otherwise a no-op edit would send the params down the re-bind path with
    // nothing to bind, which is a different outcome than the human intended.
    const r = mapReviewDecision({ ...approved, ...HUMAN, decision: 'approved', edited_payload: {} });
    expect(r.data).toMatchObject({ decision: 'approved' });
  });

  it("an explicit 'edited' with no payload still fails closed", () => {
    const r = mapReviewDecision({ ...approved, ...HUMAN, decision: 'edited', edited_payload: null });
    expect(r.error?.code).toBe('edited_no_content');
  });
});
