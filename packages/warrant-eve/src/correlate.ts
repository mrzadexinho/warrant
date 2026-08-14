// correlate.ts: the one correlation helper. Call it, then extract it, then duplicate it with a
// written reason, and a correlation helper is the last thing in this package that should exist
// twice.
//
// It moved verbatim out of `resume.ts`, comment and all. `execute.ts` deliberately keeps its own
// stricter lookup: it requires **exactly one** `warrant.issued` and throws `warrant_missing`
// otherwise, because it stands between authority and a side effect and ambiguity there is a
// refusal, not a first match. Folding that into this helper would force one shape onto two
// positions with different obligations: the same argument the boundary register makes about
// `verifyAuthorizedParams` having three call sites and keeping three shapes.
import type { LedgerEntry } from '@idriszade/warrant-ledger';

/**
 * **Absence must not be a value that can match another absence.**
 *
 * A missing `requestId` on both sides would make `undefined === undefined` true, letting a
 * hand-built ledger mint a fully signed warrant. **Typing the parameter differently would not
 * fix it**, which is why the guard is here and not at a cast: the missing thing is a
 * **presence** check, not a shape claim.
 *
 * Callers refuse an absent id outright before reaching this. This guard is the second half of the
 * same rule, kept because a correlation helper that can match on absence is a hazard wherever it
 * is reached from, currently `resume.ts` and `approval.ts` both.
 */
export function findByRequestId(
  entries: LedgerEntry[],
  event: LedgerEntry['event'],
  requestId: string,
): LedgerEntry | undefined {
  if (typeof requestId !== 'string' || requestId === '') return undefined;
  return entries.find(e => {
    if (e.event !== event) return false;
    if (typeof e.payload !== 'object' || e.payload === null) return false;
    const candidate = (e.payload as Record<string, unknown>)['requestId'];
    // Both halves matter: a non-string candidate must not coerce, and an absent one must not
    // match an absent needle. The needle is already known present by the guard above.
    return typeof candidate === 'string' && candidate === requestId;
  });
}
