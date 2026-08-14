// portfolio/packages/warrant-gatewerk/src/sim-gate.ts
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { ReviewContent, ReviewRequest, ReviewDecision, Gate } from './types.js';

type ScriptEntry = 'approve' | 'edit' | 'reject';
interface Stored { verdict: ScriptEntry; content: ReviewContent }

/**
 * What the simulated human typed.
 *
 * **Injected, never invented.** What a reviewer edits is domain knowledge, and
 * this package does not know the shape of `ReviewContent`. A
 * SimGate that manufactured an edit (appending a marker to a `body`, say)
 * would be a domain assumption wearing a domain-blind name, in the one place
 * nobody thinks to look because it is "only a simulator".
 */
export type SimEdit = (content: ReviewContent) => ReviewContent;

export interface SimGateOptions {
  /** Required in practice whenever the script contains `'edit'`; see the constructor. */
  editContent?: SimEdit;
}

export class SimGate implements Gate {
  readonly #script: ScriptEntry[];
  readonly #editContent: SimEdit | undefined;
  readonly #store = new Map<string, Stored>();
  #counter = 0;

  constructor(script: ScriptEntry[], opts: SimGateOptions = {}) {
    this.#script = [...script];
    this.#editContent = opts.editContent;
    // Refused at CONSTRUCTION rather than at fetchDecision. A script that says
    // 'edit' with nothing to edit with is a test that cannot mean what it says,
    // and the failure belongs where its author is looking, not several awaits
    // later, inside the code under test, where it would read as that code's bug.
    // A throw and not a WarrantError: this is a wiring mistake, not a Gate
    // outcome a caller should handle, and inventing a public error code that
    // only a misconfigured harness can reach would add a code no test of the
    // real path can exercise.
    if (this.#script.includes('edit') && this.#editContent === undefined) {
      throw new Error(
        "SimGate: the script contains 'edit' but no editContent was supplied. What a human "
        + 'edits is domain knowledge; this package is domain-blind and will not invent it. '
        + 'Pass { editContent } describing the edit your test means.',
      );
    }
  }

  async submit(r: ReviewRequest): Promise<Result<{ reviewId: string }, WarrantError>> {
    const idx = this.#counter++;
    const verdict = this.#script[idx] ?? 'approve';
    const reviewId = `sim-${idx}`;
    this.#store.set(reviewId, { verdict, content: r.content });
    return ok({ reviewId });
  }

  async fetchDecision(reviewId: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> {
    const stored = this.#store.get(reviewId);
    if (!stored) {
      return err({ type: 'transient', code: 'gatewerk_api_error', message: `SimGate: unknown reviewId ${reviewId}` });
    }
    const { verdict, content } = stored;
    // 'sim-reviewer' is a synthetic human identity: SimGate stands in for a real
    // reviewer in local dev/e2e, never for the system-timeout/monitoring paths.
    if (verdict === 'approve') return ok({ reviewId, decision: 'approved', decidedBy: 'sim-reviewer' });
    if (verdict === 'reject') return ok({ reviewId, decision: 'rejected', decidedBy: 'sim-reviewer' });
    const edit = this.#editContent;
    if (edit === undefined) {
      // Unreachable: the constructor refuses this combination, and 'edit' is
      // never the script-overrun default. Kept as a throw so the guarantee is
      // stated rather than assumed.
      throw new Error('SimGate: unreachable, edit verdict with no editContent');
    }
    return ok({
      reviewId,
      decision: 'edited',
      decidedBy: 'sim-reviewer',
      editedContent: edit(content),
    });
  }
}
