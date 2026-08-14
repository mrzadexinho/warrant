// portfolio/packages/warrant-gatewerk/src/rebind.ts
import type { ReviewContent, ReviewDecision } from './types.js';

/**
 * GhostApproval re-bind helper for the 'edited' review path.
 *
 * When the decision carries edited content, that content IS the new params;
 * otherwise the original params stand. **Field-blind:**
 * `ReviewContent` is opaque, so this cannot know, and must not assume, which
 * keys a human is able to edit.
 *
 * IT REPLACES, IT DOES NOT MERGE. Replacement is the fail-closed direction: a
 * partial edited payload loses the keys it omits and the caller's shape guard
 * rejects the result, where a merge would silently back-fill them, producing
 * params in a combination no human ever saw as a whole.
 *
 * IMPORTANT: the CALLER recomputes paramsHash over the returned object and
 * issues the new warrant bound to that hash; the executor re-verifies that hash
 * before execution. The caller is equally responsible for shape-guarding the
 * result before it becomes params: this function's output is data the Gate
 * supplied, and no type here constrains it.
 */
export function rebindParamsForEdit(
  decision: ReviewDecision,
  originalParams: ReviewContent,
): ReviewContent {
  if (!decision.editedContent) {
    return { ...originalParams };
  }
  return { ...decision.editedContent };
}
