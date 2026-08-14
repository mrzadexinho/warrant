// Guards on the MINT path (src/resume-issue.ts) that a second mutation sweep found
// uncovered: deleting each one left all 542 tests across the nine warrant packages green.
//
// This is the file where a human's review becomes a signed warrant, so a guard that
// stops existing here is the difference between "a human authorized these exact bytes"
// and a certificate that says so without it being true.
//
// Every test below was checked by re-deleting its guard and confirming the test then
// fails, and the deletion was diffed to prove it applied. Where the guard is genuinely
// unreachable through the product's own paths, the test says so and pins what the guard
// actually contributes rather than pretending to a reachability it does not have.
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import type { Gate, ReviewRequest, ReviewDecision } from '@idriszade/warrant-gatewerk';
import { resumeByPoll } from '../src/index.js';
// Not on the package's public surface: `isEmailContent` is reached here
// through the module because the branch below has no product path to it.
import { isEmailContent } from '../src/resume-issue.js';
import { KEYS, SESSION_ID, makeDeps, seedReview } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

const EMAIL: EmailInput = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello' };
const DECIDED_BY = 'reviewer:erin';

/** Approves any reviewId, including runs assembled by hand that SimGate never issued. */
const approveAnyGate: Gate = {
  submit: async (_r: ReviewRequest) => ok({ reviewId: 'approve-any-0' }),
  fetchDecision: async (id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
    ok({ reviewId: id, decision: 'approved' as const, decidedBy: DECIDED_BY }),
};

/** A gate that hands back whatever editedContent the test wants to smuggle through. */
function editGateReturning(editedContent: unknown): Gate {
  return {
    submit: async (_r: ReviewRequest) => ok({ reviewId: 'edit-0' }),
    fetchDecision: async (_id: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> =>
      ok({
        reviewId: 'edit-0', decision: 'edited' as const, decidedBy: DECIDED_BY,
        editedContent: editedContent as ReviewDecision['editedContent'],
      }),
  };
}

async function eventsOf(ledger: { readRun: (id: string) => Promise<{ data: Array<{ event: string }> | null }> }) {
  return (await ledger.readRun(SESSION_ID)).data!.map((e) => e.event);
}

/**
 * Seeds a human-path run whose `review.submitted` carries `content` VERBATIM,
 * including values `seedReview` cannot produce because the binding is typed.
 * The ledger is the trust boundary here: a payload is `unknown` on the way out,
 * and nothing between the row and `isEmailContent` re-checks it.
 */
async function seedRawReview(content: unknown, reviewId: string): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  const principal = { kind: 'agent' as const, id: 'agent-outbound' };
  const at = '2026-07-18T10:00:00.000Z';
  for (const [event, payload] of [
    ['warrant.requested', { requestId: 'call-1', actionKind: 'send_email', target: 'p@example.com', context: { audience: 'cold' } }],
    ['policy.evaluated', { requestId: 'call-1', ruleId: 'send_email_cold', path: 'human' }],
    ['review.submitted', { requestId: 'call-1', reviewId, content }],
  ] as const) {
    const a = await ledger.append({ runId: SESSION_ID, at, event, principal, payload });
    expect(a.error).toBeNull();
  }
  return ledger;
}

// isEmailContent is the shape guard between a reviewer's edit and a signed warrant.
// Its four conditions were measured separately: deleting the whole guard was caught,
// but deleting any single condition was not, which means only the missing-`to` case
// had ever been exercised.
describe('isEmailContent: each field check, not just the guard as a whole', () => {
  it('a non-string subject is refused, and nothing is minted', async () => {
    // Without `typeof o['subject'] === 'string'` this mints: paramsHash accepts a
    // number perfectly well, so the run ends with a signed warrant attesting that a
    // human approved a subject line that is not text.
    const deps = makeDeps({ gate: editGateReturning({ to: 'ok@example.com', subject: 42, body: 'Hello' }) });
    const reviewId = await seedReview(deps, EMAIL);
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error?.code).toBe('malformed_review_content');
    expect(await eventsOf(deps.ledger)).not.toContain('warrant.issued');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a non-string body is refused, and nothing is minted', async () => {
    const deps = makeDeps({ gate: editGateReturning({ to: 'ok@example.com', subject: 'Intro', body: { html: '<p>' } }) });
    const reviewId = await seedReview(deps, EMAIL);
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error?.code).toBe('malformed_review_content');
    expect(await eventsOf(deps.ledger)).not.toContain('warrant.issued');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('an empty recipient is refused, and nothing is minted', async () => {
    // `o['to'] !== ''` is separate from the typeof check and had no coverage. An empty
    // string is a string, so without it the mint proceeds and the warrant's signed
    // action.target is the empty string: an authorization naming nobody, which the
    // executor would then happily match against a tool input that also has no
    // recipient. Policy does not save this either, because no protectedAudience
    // pattern matches ''.
    const deps = makeDeps({ gate: editGateReturning({ to: '', subject: 'Intro', body: 'Hello' }) });
    const reviewId = await seedReview(deps, EMAIL);
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error?.code).toBe('malformed_review_content');
    expect(await eventsOf(deps.ledger)).not.toContain('warrant.issued');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a valid edit still mints, so the guard is not refusing everything', async () => {
    // The positive case. A shape guard tightened into rejecting all edits passes every
    // assertion above while breaking the product.
    const deps = makeDeps({ gate: editGateReturning({ to: 'ok@example.com', subject: 'Intro', body: 'Hello' }) });
    const reviewId = await seedReview(deps, EMAIL);

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
    const issued = (await deps.ledger.readRun(SESSION_ID)).data!.find((e) => e.event === 'warrant.issued');
    const w = (issued!.payload as Record<string, unknown>)['warrant'] as { action: { target: string } };
    expect(w.action.target).toBe('ok@example.com');
  });

  // `mintHumanWarrant`'s `content` parameter is `unknown`, not `EmailContent`, because the
  // caller reads it off a ledger payload and nobody has checked it. These two pin that the
  // guard is what refuses a bad value, never the type: a scalar is a case a narrower parameter
  // type would make unwritable while the ledger can always hold it.
  it('a SCALAR content on the approved path is refused by the guard, not by the type', async () => {
    const ledger = await seedRawReview('to: ok@example.com', 'scalar-content-0');
    const deps = makeDeps({ ledger, gate: approveAnyGate });

    const r = await resumeByPoll(deps, { reviewId: 'scalar-content-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('malformed_review_content');
    expect(r.error?.type).toBe('validation');
    expect(await eventsOf(ledger)).not.toContain('warrant.issued');
  });

  it('a scalar content on the EDITED path still mints, and the edit alone is authorized', async () => {
    // What this pins is the INPUT DOMAIN, not the coercion. The coercion of a
    // non-object original to `{}` was probed by replacing it with a fully-formed
    // poison email: all eight tests here stayed green, because step 6 refuses an
    // `edited` decision with no editedContent and rebind replaces rather than
    // merges, so `originalParams` is discarded on every reachable edited path.
    // Said plainly rather than left as an implied guarantee this test does not
    // give. What it does give: a `content` value the old `EmailContent` parameter
    // made unwritable at the call site, and which the ledger could always hold,
    // now demonstrably neither throws nor reaches the authorized params.
    const ledger = await seedRawReview(42, 'scalar-edit-0');
    const deps = makeDeps({
      ledger,
      gate: editGateReturning({ to: 'ok@example.com', subject: 'Intro', body: 'Hello' }),
    });

    const r = await resumeByPoll(deps, { reviewId: 'scalar-edit-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error).toBeNull();
    expect(r.data).toBe('issued');
    const issued = (await ledger.readRun(SESSION_ID)).data!.find((e) => e.event === 'warrant.issued');
    const p = issued!.payload as Record<string, unknown>;
    expect(p['authorized']).toEqual({ to: 'ok@example.com', subject: 'Intro', body: 'Hello' });
    expect((p['warrant'] as { action: { target: string } }).action.target).toBe('ok@example.com');
  });

  // The `typeof v !== 'object'` half, which until now NO test killed: deleting it
  // and running all eighteen warrant-eve files left them green. It is unreachable
  // through the product: the approved path's content is JSON off the ledger and
  // the edited path's is rebind's spread, so neither can produce a non-object that
  // indexes to strings, so it is pinned directly, at the only altitude where the
  // difference is observable, rather than left as a condition nothing measures.
  it('a callable carrying the three fields is refused, which only the typeof half does', () => {
    const callable = Object.assign(() => undefined, { to: 'ok@example.com', subject: 'Intro', body: 'Hello' });

    // typeof is 'function', so every field check below passes and the typeof check
    // is the sole thing standing between this and a signed warrant.
    expect(typeof callable).toBe('function');
    expect(callable['to']).toBe('ok@example.com');
    expect(isEmailContent(callable)).toBe(false);
  });

  it('a null content on the APPROVED path returns a typed refusal, not a thrown TypeError', async () => {
    // The `v === null` half. On the approved path `raw` is the review.submitted content
    // read straight back off the ledger, never re-validated, so a run whose content row
    // is null reaches isEmailContent as null. Without the null check the very next line
    // indexes it and throws, and resumeByPoll's outer catch relabels that as
    // resume_internal_error: a transient code, which tells a caller to retry something
    // that will never succeed. The guard's contribution is the honest classification,
    // and that is what this pins. The approved branch passes `content` through untouched, so
    // this branch is live.
    const ledger = await seedRawReview(null, 'null-content-0');
    const deps = makeDeps({ ledger, gate: approveAnyGate });

    const r = await resumeByPoll(deps, { reviewId: 'null-content-0', runId: SESSION_ID, deliver: vi.fn() });

    expect(r.error?.code).toBe('malformed_review_content');
    expect(r.error?.type).toBe('validation');
    expect(await eventsOf(ledger)).not.toContain('warrant.issued');
  });
});

describe('a warrant that cannot be issued is a denial, not a silent pass', () => {
  it('issueWarrant failing records warrant.denied with the reason and never delivers', async () => {
    // Reached with an unusable signing key, which is a real deployment failure mode
    // (a truncated or rotated-away secret) and the only one that makes issueWarrant
    // fail after the content has already passed the shape and policy checks. Without
    // the guard, `issued.data` is null and the next line reads `.action` off it.
    const deps = makeDeps({
      gate: new SimGate(['approve']),
      keys: { privateKeyHex: 'not-a-key', publicKeyHex: KEYS.publicKeyHex },
    });
    const reviewId = await seedReview(deps, EMAIL);
    const deliver = vi.fn();

    const r = await resumeByPoll(deps, { reviewId, runId: SESSION_ID, deliver });

    expect(r.error?.code).toBe('issue_failed');
    const entries = (await deps.ledger.readRun(SESSION_ID)).data!;
    expect(entries.map((e) => e.event)).not.toContain('warrant.issued');
    // The mint failure is recorded as a denial rather than vanishing, and the reason
    // carried through is the mint's own code, not a generic one.
    const denied = entries.find((e) => e.event === 'warrant.denied');
    expect(denied).toBeDefined();
    expect((denied!.payload as Record<string, unknown>)['reason']).toBe('issue_failed');
    // A failed mint is not an outcome anyone gets told about.
    expect(deliver).not.toHaveBeenCalled();
  });
});
