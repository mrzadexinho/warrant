// portfolio/packages/warrant-gatewerk/src/preflight.ts
//
// Ceremony preflight (Pass 2 contract P5, master plan line 272): refuse to
// start a governed run at all unless the configured Gatewerk template is
// provably not self-deciding.
//
// This is the THIRD layer of C7 and the only one that PREVENTS rather than
// detects. C6 (never submit oversight:'monitoring', never submit a timeout)
// shapes the create request; C7's mapReviewDecision (isSystemDecider +
// isMachineAction) inspects the decision. Both run after the review already
// exists, and Gatewerk's per-template auto_approve fires at review CREATE from
// server-side config we never send: crud.ts stamps status:'decided',
// decision:'approved', decided_by:'system/auto-approve' before any human sees
// it, gated on `tpl.auto_approve && data.oversight !== "monitoring"`, a
// condition our own C6 'blocking' setting satisfies. By the time layers one
// and two can speak, the damage is done. Only not starting closes it.
//
// NO process.env reads: pillar 7, same as gatewerk-gate.ts. fetch is injected.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

export interface PreflightTemplate {
  templateId: string;
  slug: string;
  autoApprove: boolean;
  /**
   * The template's default timeout in seconds, or null when it has none. REPORTED, not judged:
   * unlike auto_approve this is not a security question, and what counts as an acceptable value
   * depends on how long the human running the ceremony is expected to take. The caller decides.
   *
   * It matters because it is the template knob that IS inherited. crud.ts computes
   * `data.timeout?.seconds || tpl.timeout_seconds` and writes expires_at from it, so a template
   * default applies even though C6 never sends a timeout. The review's timeout_action, by contrast,
   * is written from `data.timeout?.action` alone and is NOT inherited, so at expiry the worker
   * falls back to `review.timeout_action || "expire"` and expires the review. Warrant reads an
   * expired review as a rejection, which is fail-closed: the risk is a ceremony that dies mid-run
   * for no visible reason, not one that self-approves.
   */
  timeoutSeconds: number | null;
}

// The !Array.isArray(v) clause is REDUNDANT on reachable input and is kept
// only so the predicate matches its name. Measured in the guard-deletion
// sweep: deleting it leaves the suite green, and it cannot fail, because a
// JSON-parsed array can never carry a named property. At the body call site
// an array's .items is always undefined, so the Array.isArray(items) guard
// below returns the same gatewerk_api_error; at the filter call site an
// array's .slug is always undefined and can never equal a slug string.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * GET {baseUrl}/api/v1/templates (Bearer, scope templates:read) and match on
 * slug. The by-id route GET /api/v1/templates/:id looks up by ID, not slug,
 * so listing and matching is the only way to resolve a configured slug.
 */
export async function preflightGatewerkTemplate(opts: {
  baseUrl: string;
  apiKey: string;
  templateSlug: string;
  fetchImpl?: typeof fetch;
}): Promise<Result<PreflightTemplate, WarrantError>> {
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl}/api/v1/templates`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
  } catch (e) {
    return err({
      type: 'transient',
      code: 'gate_unreachable',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // Short-circuit before reading the body: a 401/403 page must never be able
  // to satisfy the preflight, whatever it happens to contain.
  if (!res.ok) {
    return err({
      type: 'transient',
      code: 'gatewerk_api_error',
      message: `${res.status} ${res.statusText}`,
    });
  }

  // res.json() throws on a non-JSON body (an upstream proxy's HTML error
  // page is the realistic case). Never throw across this boundary.
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return err({
      type: 'transient',
      code: 'gatewerk_api_error',
      message: `templates list body was not JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Gatewerk's list envelope: { object:'list', items:[...], has_more, total? }.
  const items: unknown = isRecord(body) ? body.items : undefined;
  if (!Array.isArray(items)) {
    return err({
      type: 'transient',
      code: 'gatewerk_api_error',
      message: 'templates list response carried no items array',
    });
  }

  // Fail closed on a paged response. Gatewerk returns every project template in one shot with
  // has_more hardcoded false today (templates.ts service), so this never fires. But the duplicate
  // check below exists precisely because this client must not assume slug uniqueness holds, and
  // reading only page one would reintroduce that assumption through the back door: a shadow
  // template carrying auto_approve true on page two is invisible, and the ok would be returned on
  // the safe page-one copy. Refusing beats paging we cannot test against a live paging server.
  if (isRecord(body) && body.has_more === true) {
    return err({
      type: 'validation',
      code: 'preflight_template_list_paged',
      message: 'templates list reported has_more: this client reads one page and will not '
        + 'certify a template list it has not seen in full',
    });
  }

  const matches = items.filter(
    (i): i is Record<string, unknown> => isRecord(i) && i.slug === opts.templateSlug,
  );
  if (matches.length === 0) {
    return err({
      type: 'validation',
      code: 'preflight_template_missing',
      message: `no Gatewerk template with slug '${opts.templateSlug}'`,
    });
  }
  // Gatewerk holds templates_project_id_slug_uniq, so more than one match
  // should be impossible: which is exactly why this client must not assume it
  // and quietly take the first. Two rows means one of them is unaudited.
  if (matches.length > 1) {
    return err({
      type: 'integrity',
      code: 'preflight_template_ambiguous',
      message: `${matches.length} Gatewerk templates share slug '${opts.templateSlug}'`,
    });
  }

  const tpl = matches[0] as Record<string, unknown>;

  if (tpl.auto_approve === true) {
    return err({
      type: 'integrity',
      code: 'preflight_template_auto_approve',
      message: `template '${opts.templateSlug}' has auto_approve true: reviews are decided at create by system/auto-approve`,
    });
  }
  // CORRECTED after an adversarial pass checked this against the source. The review's
  // timeout_action is written from `data.timeout?.action` alone (crud.ts:179); there is no
  // `?? tpl.timeout_action` fallback, so on the create path C6 uses a template default does
  // NOT reach the review, and the worker falls back to `review.timeout_action || "expire"`.
  // The guard stays because it costs nothing and the chain-run path DOES inherit it
  // (chain-engine.ts), but it is not the knob that bites this flow. timeoutSeconds, reported
  // below, is: crud.ts:98 inherits it into expires_at whether or not we send one.
  if (tpl.timeout_action === 'auto_approve') {
    return err({
      type: 'integrity',
      code: 'preflight_template_timeout_auto_approve',
      message: `template '${opts.templateSlug}' defaults timeout_action to auto_approve`,
    });
  }
  // Indeterminate is an ERROR, not a pass. An unreadable template config is
  // exactly the state where layers one and two are load-bearing and nothing
  // has verified them. Note the string 'false' is truthy, which is how this
  // class of bug ships.
  if (typeof tpl.auto_approve !== 'boolean') {
    return err({
      type: 'validation',
      code: 'preflight_template_indeterminate',
      message: `template '${opts.templateSlug}' reported a non-boolean auto_approve (${typeof tpl.auto_approve})`,
    });
  }
  // Never fabricate an identifier, same rule as gatewerk_missing_review_id:
  // this id names the template the ceremony attests it verified.
  if (typeof tpl.id !== 'string' || tpl.id.trim() === '') {
    return err({
      type: 'validation',
      code: 'preflight_template_indeterminate',
      message: `template '${opts.templateSlug}' carried no usable id`,
    });
  }

  // Reported, not judged. A number is a real default that will stamp expires_at on the ceremony's
  // review; anything else (absent, null, non-numeric) means the template sets none. Non-finite and
  // non-positive values are normalized to null because they cannot express a real timeout, and
  // crud.ts's `data.timeout?.seconds || tpl.timeout_seconds` treats 0 as absent anyway.
  const rawTimeout = tpl.timeout_seconds;
  const timeoutSeconds = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : null;

  return ok({ templateId: tpl.id, slug: opts.templateSlug, autoApprove: false, timeoutSeconds });
}
