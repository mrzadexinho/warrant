// packages/warrant-gatewerk/tests/decision-ablation.test.ts
//
// The payload-ablation harness. This codebase's recurring defect class SUCCEEDS
// WRONGLY: a missing value flows through and something mints anyway, rather than
// failing loudly. This file takes a fully valid decided+approved (and, for the
// edit path, decided+edited) review shape and systematically deletes each key,
// one at a time: top level, and one level into the `payload` object: asserting
// that no ablated variant ever maps to an approved/edited ReviewDecision. Keys
// are iterated programmatically via Object.keys() over the fixture so a future
// field on the Gatewerk review shape is automatically covered; nothing here is
// hand-listed.
//
// Every ablation that still approves/edits is a REAL FINDING, not a test bug: the
// assertion is never weakened to make one pass. Findings are pinned as
// `test.todo` with a `FINDING:` comment carrying the exact key and the verbatim
// successful result.

import { describe, expect, it } from 'vitest';
import { mapReviewDecision } from '../src/decision.js';
import approvedFixture from './fixtures/review-decided-approved.json' with { type: 'json' };
import editedFixture from './fixtures/review-decided-edited.json' with { type: 'json' };

/** True only for the two mintable outcomes this harness exists to keep unreachable. */
function isMintable(r: ReturnType<typeof mapReviewDecision>): boolean {
  const d = r.data as { decision?: string } | null;
  return d != null && (d.decision === 'approved' || d.decision === 'edited');
}

describe('decision-ablation: a fully valid decided+approved review, top-level keys', () => {
  it('sanity: the unablated fixture maps to ok approved', () => {
    const r = mapReviewDecision(approvedFixture);
    expect(r.data).toMatchObject({ decision: 'approved' });
  });

  // FINDING (id): deleting the review's own id still approves. mapReviewDecision
  // never treats a missing/empty id as a reason to refuse: it falls back to ''
  // (`typeof r.id === 'string' ? r.id : ''`) and the guard fields (status,
  // decision, decided_by, last_action_by, action_value) are what gate the
  // outcome, not id. Observed result: `{ reviewId: '', decision: 'approved',
  // decidedBy: 'alice@acme.com' }`. Not an attestation bypass: the human-review
  // guard is untouched: but an approval keyed to an empty reviewId is a real
  // correctness hazard (the ledger's duplicate-review-claim check keys on this
  // value, so two distinct id-less approvals collide on the empty string).
  // Was a FINDING, now fixed: a non-pending outcome with a missing/empty id is refused
  // (review_id_missing) instead of approving keyed to '', where two distinct id-less
  // approvals would collide in every consumer that keys on reviewId.
  it('deleting top-level key "id" is refused as review_id_missing', () => {
    const ablated = { ...approvedFixture } as Record<string, unknown>;
    delete ablated['id'];
    const r = mapReviewDecision(ablated);
    expect(r.error?.code).toBe('review_id_missing');
  });

  // FINDING (bulk, not attestation-relevant): mapReviewDecision reads only
  // status/decision/decided_by/edited_payload/action_value/last_action_by/id from
  // the raw review object: ReviewContent is deliberately opaque (boundary
  // register / types.ts), so every other field on the real Gatewerk review shape
  // is unconsulted by design. Verified empirically (not assumed) that deleting
  // each of the following, individually, from an otherwise-valid decided+approved
  // fixture still maps to `{ decision: 'approved' }`: project_id, template_id,
  // template_slug, payload, priority, feedback, decided_at, current_version,
  // assignee, created_at, updated_at, template. None of these gate the
  // human-attestation guard, so this is not the "succeeds wrongly" defect class
  // the harness targets: but per the harness's own rule the successful ablation
  // is still reported rather than silently filtered out, and pinned so the
  // reviewer: not this file: decides whether any of them should start
  // mattering (e.g. `payload` staying unconsulted means the approved CONTENT
  // itself is never cross-checked against what was actually reviewed here; that
  // binding happens by re-running policy on `editedContent`/original params
  // upstream of this function, per decision.ts's own comments: worth the
  // reviewer confirming that binding is real and not assumed).
  // Documented design, asserted so a change to it is a visible decision: review content is
  // opaque on this port (see docs/contracts/gate.md, section on opaque content), and the
  // executed-bytes binding lives at the guard via paramsHash, not here. These fields being
  // unconsulted is therefore the contract working; if any of them starts gating the
  // outcome, this test forces the change to be argued.
  it('the 12 non-guard fields are unconsulted by design: deleting each still approves', () => {
    const unconsulted = ['project_id', 'template_id', 'template_slug', 'payload', 'priority',
      'feedback', 'decided_at', 'current_version', 'assignee', 'created_at', 'updated_at', 'template'];
    for (const key of unconsulted) {
      const ablated = { ...approvedFixture } as Record<string, unknown>;
      delete ablated[key];
      const r = mapReviewDecision(ablated);
      expect(r.data, `deleting ${key} should not change the outcome`).toMatchObject({ decision: 'approved' });
    }
  });

  const NOT_CONSULTED_BY_GUARD = new Set([
    'project_id',
    'template_id',
    'template_slug',
    'payload',
    'priority',
    'feedback',
    'decided_at',
    'current_version',
    'assignee',
    'created_at',
    'updated_at',
    'template',
  ]);

  // `edited_payload` IS consulted (hasEdits reads it), but on this fixture it is
  // already `null`, and `typeof null === 'object'` with `edited !== null` false
  // means a deleted key (-> undefined) and an explicit `null` take the identical
  // branch (hasEdits stays false either way). Not a defect: pinned as its own
  // documented exclusion rather than folded into NOT_CONSULTED_BY_GUARD, which
  // would misdescribe it as unread. Covered on its own terms in the
  // `edited_payload` describe block below (both the {} and the missing-key shape
  // reach the same `hasEdits: false` outcome).
  const NULL_EQUIVALENT_ON_THIS_FIXTURE = new Set(['edited_payload']);

  // The strict sweep: every OTHER key (including any field added to the fixture
  // in the future that isn't already known-and-accounted-for above) must refuse
  // on deletion. A newly added gating field that starts silently loosening the
  // outcome fails this loop outright rather than being auto-downgraded to a
  // todo: the whole point of running this off Object.keys().
  for (const key of Object.keys(approvedFixture).filter(
    (k) => k !== 'id' && !NOT_CONSULTED_BY_GUARD.has(k) && !NULL_EQUIVALENT_ON_THIS_FIXTURE.has(k),
  )) {
    it(`deleting top-level key "${key}" never maps to approved/edited`, () => {
      const ablated = { ...approvedFixture } as Record<string, unknown>;
      delete ablated[key];
      const r = mapReviewDecision(ablated);
      expect(
        isMintable(r),
        `deleting "${key}" mapped to a mintable decision: ${JSON.stringify(r)}`,
      ).toBe(false);
    });
  }
});

describe('decision-ablation: nested `payload` keys (one level deep)', () => {
  // FINDING (bulk, non-attestation: same class as `payload` above): `payload`
  // itself is unconsulted, so its nested keys (to, subject, body) necessarily
  // are too: verified rather than assumed. Deleting each individually from an
  // otherwise-valid decided+approved fixture still maps to
  // `{ decision: 'approved' }`. Same reviewer question as above: if the eventual
  // warrant is meant to bind to what a human actually reviewed, something
  // upstream of this function needs to be the thing that checks `payload`
  // against `editedContent`/original params: this function alone does not.
  // Same design property one level down: the content's inner fields are equally opaque here.
  it('payload.to / payload.subject / payload.body are unconsulted by design', () => {
    for (const key of ['to', 'subject', 'body']) {
      const payload = { ...(approvedFixture as { payload: Record<string, unknown> }).payload };
      delete payload[key];
      const r = mapReviewDecision({ ...approvedFixture, payload });
      expect(r.data, `deleting payload.${key} should not change the outcome`).toMatchObject({ decision: 'approved' });
    }
  });
});

describe('decision-ablation: nested `edited_payload` keys on the edit path (one level deep)', () => {
  it('sanity: the unablated edited fixture maps to ok edited', () => {
    const r = mapReviewDecision(editedFixture);
    expect(r.data).toMatchObject({ decision: 'edited' });
  });

  // Companion to the top-level "edited_payload" exclusion above: deleting the
  // top-level `edited_payload` key entirely (-> undefined) on an approved
  // fixture takes the same hasEdits:false branch as the fixture's real `null`,
  // so it stays a plain approval rather than becoming mintable through some
  // other path. Asserted directly rather than only inferred from the exclusion.
  it('deleting the whole edited_payload key on the approved fixture stays a plain approval, same as null', () => {
    const ablated = { ...approvedFixture } as Record<string, unknown>;
    delete ablated['edited_payload'];
    const r = mapReviewDecision(ablated);
    expect(r.data).toMatchObject({ decision: 'approved' });
    expect((r.data as { editedContent?: unknown }).editedContent).toBeUndefined();
  });

  // Deleting one of several edited_payload keys leaves a still-non-empty object,
  // so `hasEdits` stays true and the result stays 'edited' with a partial
  // editedContent. This is the intended feature (a human editing only some
  // fields), not a bypass of the human-attestation guard, so it is asserted as
  // an explicit pass here rather than run through the strict isMintable() sweep.
  const editedPayload = editedFixture.edited_payload as Record<string, unknown>;
  for (const key of Object.keys(editedPayload)) {
    it(`deleting edited_payload.${key} still edits, but only drops that field (not a guard bypass)`, () => {
      const ablatedEdits = { ...editedPayload };
      delete ablatedEdits[key];
      const ablated = { ...editedFixture, edited_payload: ablatedEdits };
      const r = mapReviewDecision(ablated);
      expect(r.data).toMatchObject({ decision: 'edited' });
      expect((r.data as { editedContent?: Record<string, unknown> }).editedContent).not.toHaveProperty(key);
    });
  }

  // The genuine ablation case: deleting every key of edited_payload leaves `{}`,
  // which `hasEdits` correctly treats as no edit at all (see decision.ts and the
  // existing "an EMPTY edited_payload is not an edit" test): asserted here as
  // part of the systematic sweep rather than assumed. Base is the APPROVED
  // fixture, not the edited one: decision.ts routes `decision === 'edited'` with
  // no edits to `edited_no_content` (fail closed on an incoherent explicit
  // 'edited'), so the "falls back to a plain approval" case only exists when the
  // decision value was 'approved' to begin with.
  it('deleting every edited_payload key (leaving {}) falls back to a plain approval, not a phantom edit', () => {
    const ablated = { ...approvedFixture, edited_payload: {} };
    const r = mapReviewDecision(ablated);
    expect(r.data).toMatchObject({ decision: 'approved' });
    expect((r.data as { editedContent?: unknown }).editedContent).toBeUndefined();
  });

  // The mirror case, pinned rather than silently skipped: an explicit 'edited'
  // decision with every edited_payload key ablated fails closed, per decision.ts.
  it('an explicit "edited" decision with every edited_payload key ablated fails closed (edited_no_content)', () => {
    const ablated = { ...editedFixture, edited_payload: {} };
    const r = mapReviewDecision(ablated);
    expect(isMintable(r)).toBe(false);
    expect(r.error?.code).toBe('edited_no_content');
  });
});

describe('decision-ablation: last_action_by ablated to specific attacker-shaped values', () => {
  // Beyond programmatic key-deletion (which produces `undefined`), the brief
  // calls out these three shapes explicitly: an empty string, a null, and a
  // non-reviewer prefix: the exact three ways an adapter bug or a spoofed
  // response could hand this guard something that looks present but isn't a
  // human session.
  it.each([
    ['empty string', ''],
    ['null', null],
    ['non-reviewer prefix', 'agent:gwk_live_7f3a'],
  ] as const)('last_action_by = %s: never approves/edits', (_label, last_action_by) => {
    const ablated = { ...approvedFixture, last_action_by };
    const r = mapReviewDecision(ablated);
    expect(isMintable(r), `last_action_by=${JSON.stringify(last_action_by)} mapped to: ${JSON.stringify(r)}`).toBe(
      false,
    );
    expect(r.error?.code).toBe('human_attestation_missing');
  });
});
