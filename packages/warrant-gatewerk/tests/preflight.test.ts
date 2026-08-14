// portfolio/packages/warrant-gatewerk/tests/preflight.test.ts
//
// Contract P5 (Pass 2 plan) / master:272. The preflight is the THIRD layer of
// C7 and the only one that PREVENTS a review from being auto-decided: C6 and
// mapReviewDecision both run after the review already exists. Every case here
// asserts the EXACT error code and that no ok payload leaked, because a
// preflight that returns ok on an unreadable template config is the state
// where the other two layers are load-bearing and nothing has verified them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { preflightGatewerkTemplate } from '../src/preflight.js';
import { preflightGatewerkTemplate as exported } from '../src/index.js';
import templatesList from './fixtures/templates-list.json' with { type: 'json' };

const BASE = 'https://gw.example.com';
const KEY = 'gwk_live_test-key';
const SLUG = 'warrant-outbound-email';

const FIXTURE_ITEMS = templatesList.items as unknown as Array<Record<string, unknown>>;

function goodTemplate(): Record<string, unknown> {
  const t = FIXTURE_ITEMS.find((i) => i.slug === SLUG);
  if (t === undefined) throw new Error('fixture lost its warrant-outbound-email template');
  return structuredClone(t);
}

function listResponse(items: unknown[], status = 200): Response {
  return new Response(
    JSON.stringify({ object: 'list', items, has_more: false, total: items.length }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function fetchReturning(res: Response): typeof fetch {
  return vi.fn().mockResolvedValueOnce(res) as unknown as typeof fetch;
}

async function run(fetchImpl: typeof fetch, templateSlug = SLUG) {
  return preflightGatewerkTemplate({ baseUrl: BASE, apiKey: KEY, templateSlug, fetchImpl });
}

afterEach(() => vi.restoreAllMocks());

describe('package surface', () => {
  it('src/index.ts re-exports preflightGatewerkTemplate', () => {
    expect(exported).toBe(preflightGatewerkTemplate);
  });
});

describe('preflightGatewerkTemplate: request shape', () => {
  it('GETs {baseUrl}/api/v1/templates with the Bearer header and no body', async () => {
    let captured: { url: unknown; init: RequestInit | undefined } | undefined;
    const f = vi.fn().mockImplementation(async (url: unknown, init: RequestInit | undefined) => {
      captured = { url, init };
      return listResponse(FIXTURE_ITEMS);
    }) as unknown as typeof fetch;
    await run(f);
    expect(captured?.url).toBe(`${BASE}/api/v1/templates`);
    expect(captured?.init?.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(captured?.init?.body).toBeUndefined();
    expect(captured?.init?.method ?? 'GET').toBe('GET');
    // Exactly one. Nothing else pins the call count, so a retry loop or a second probe could be
    // added without any test objecting, and this preflight runs against a live production API.
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('preflightGatewerkTemplate: pass', () => {
  it('recorded list envelope: ok with the matching templateId, slug and autoApprove false', async () => {
    const r = await run(fetchReturning(listResponse(FIXTURE_ITEMS)));
    expect(r.error).toBeNull();
    expect(r.data).toEqual({
      templateId: 'tpl_7a1e0033', slug: SLUG, autoApprove: false, timeoutSeconds: null,
    });
  });

  it('ignores an auto_approve template that is not the requested slug', async () => {
    // The fixture's nightly-digest carries auto_approve true AND
    // timeout_action auto_approve. Matching on slug must come first.
    const r = await run(fetchReturning(listResponse(FIXTURE_ITEMS)));
    expect(r.data?.templateId).toBe('tpl_7a1e0033');
  });

  // THE POSITIVE SIDE of the timeout_action guard. Without this case an over-strict variant that
  // refuses every non-null timeout_action passes the whole suite: measured, it did. Design spec
  // line 256 explicitly permits 'expire' and 'auto_reject', so refusing them would be a real
  // behaviour change no test objected to.
  it.each([['expire'], ['auto_reject'], [null]])('accepts timeout_action %j', async (action) => {
    const t = goodTemplate();
    t.timeout_action = action;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error).toBeNull();
    expect(r.data?.autoApprove).toBe(false);
  });

  // REPORTED, not judged. timeout_seconds is the template knob that IS inherited: crud.ts computes
  // `data.timeout?.seconds || tpl.timeout_seconds` and writes expires_at from it, so a template
  // default applies even though C6 never sends a timeout. Whether a given value is acceptable
  // depends on how long the human is expected to take, which this adapter cannot know.
  it.each([
    [86400, 86400],
    [60, 60],
    [null, null],
    [undefined, null],
    [0, null],
    [-5, null],
    ['3600', null],
    [Number.NaN, null],
  ])('reports timeout_seconds %j as %j without judging it', async (raw, expected) => {
    const t = goodTemplate();
    if (raw === undefined) delete t.timeout_seconds;
    else t.timeout_seconds = raw;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error).toBeNull();
    expect(r.data?.timeoutSeconds).toBe(expected);
  });
});

describe('preflightGatewerkTemplate: template-config refusals', () => {
  it('no item with the requested slug: preflight_template_missing', async () => {
    const r = await run(fetchReturning(listResponse(FIXTURE_ITEMS)), 'no-such-template');
    expect(r.error?.code).toBe('preflight_template_missing');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it('auto_approve true: preflight_template_auto_approve', async () => {
    const t = goodTemplate();
    t.auto_approve = true;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_auto_approve');
    expect(r.error?.type).toBe('integrity');
    expect(r.data).toBeNull();
  });

  it("timeout_action 'auto_approve': preflight_template_timeout_auto_approve", async () => {
    // CORRECTED. crud.ts:179 writes the review's timeout_action from `data.timeout?.action` with
    // no template fallback, so on the create path C6 uses this value does NOT reach the review.
    // The guard is kept for the chain-run path, which does inherit it; the knob that bites this
    // flow is timeout_seconds, and it is reported rather than refused (see the pass block).
    const t = goodTemplate();
    t.timeout_action = 'auto_approve';
    t.timeout_seconds = 3600;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_timeout_auto_approve');
    expect(r.error?.type).toBe('integrity');
    expect(r.data).toBeNull();
  });

  it('auto_approve absent entirely: preflight_template_indeterminate', async () => {
    const t = goodTemplate();
    delete t.auto_approve;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_indeterminate');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it('auto_approve null: preflight_template_indeterminate', async () => {
    const t = goodTemplate();
    t.auto_approve = null;
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_indeterminate');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it("auto_approve 'false' as a STRING: preflight_template_indeterminate", async () => {
    // The string 'false' is truthy, so a server or proxy that stringifies
    // booleans turns the safe value into the dangerous one. Not a boolean,
    // not a pass.
    const t = goodTemplate();
    t.auto_approve = 'false';
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_indeterminate');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it("auto_approve 'true' as a STRING: preflight_template_indeterminate, never ok", async () => {
    const t = goodTemplate();
    t.auto_approve = 'true';
    const r = await run(fetchReturning(listResponse([t])));
    expect(r.error?.code).toBe('preflight_template_indeterminate');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it.each([[undefined], [''], ['   '], [42]])(
    'matching template whose id is %j: preflight_template_indeterminate',
    async (id) => {
      const t = goodTemplate();
      if (id === undefined) delete t.id;
      else t.id = id;
      const r = await run(fetchReturning(listResponse([t])));
      expect(r.error?.code).toBe('preflight_template_indeterminate');
      expect(r.error?.type).toBe('validation');
      expect(r.data).toBeNull();
    },
  );

  it('TWO templates sharing the requested slug: preflight_template_ambiguous', async () => {
    // Gatewerk holds templates_project_id_slug_uniq, so this should be
    // impossible: which is exactly why the client must not assume it and
    // silently take the first. The second copy here is the dangerous one.
    const a = goodTemplate();
    const b = goodTemplate();
    b.id = 'tpl_shadow_9911';
    b.auto_approve = true;
    const r = await run(fetchReturning(listResponse([a, b])));
    expect(r.error?.code).toBe('preflight_template_ambiguous');
    expect(r.error?.type).toBe('integrity');
    expect(r.data).toBeNull();
  });
});

describe('preflightGatewerkTemplate: transport and envelope failures', () => {
  it.each([401, 403, 500])('HTTP %i: gatewerk_api_error, transient, no ok payload', async (status) => {
    const r = await run(fetchReturning(new Response('nope', { status })));
    expect(r.error?.code).toBe('gatewerk_api_error');
    expect(r.error?.type).toBe('transient');
    expect(r.data).toBeNull();
  });

  it('a 401 body that happens to contain a passing template is still refused', async () => {
    // Non-2xx short-circuits before any body is read: an error page must
    // never be able to satisfy the preflight.
    const r = await run(fetchReturning(listResponse(FIXTURE_ITEMS, 401)));
    expect(r.error?.code).toBe('gatewerk_api_error');
    expect(r.data).toBeNull();
  });

  it('fetch rejecting (network down): gate_unreachable', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const r = await run(f);
    expect(r.error?.code).toBe('gate_unreachable');
    expect(r.error?.type).toBe('transient');
    expect(r.data).toBeNull();
  });

  it('200 whose body is not JSON: gatewerk_api_error, never throws', async () => {
    const res = new Response('<html>upstream proxy error</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const r = await run(fetchReturning(res));
    expect(r.error?.code).toBe('gatewerk_api_error');
    expect(r.data).toBeNull();
  });

  it.each([
    ['object with no items key', { object: 'list', has_more: false }],
    ['items not an array', { object: 'list', items: { '0': { slug: SLUG } }, has_more: false }],
    ['bare null body', null],
    ['a JSON array at the top level', [{ slug: SLUG, id: 'tpl_x', auto_approve: false }]],
  ])('200 JSON body, %s: gatewerk_api_error', async (_label, body) => {
    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const r = await run(fetchReturning(res));
    expect(r.error?.code).toBe('gatewerk_api_error');
    expect(r.data).toBeNull();
  });

  it('items containing non-object entries: those entries cannot match a slug', async () => {
    const r = await run(fetchReturning(listResponse([null, 'warrant-outbound-email', 7])));
    expect(r.error?.code).toBe('preflight_template_missing');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  // A paged list is refused even when page one carries a perfectly good template. The duplicate
  // check exists because this client must not assume slug uniqueness holds; reading only page one
  // would reintroduce that assumption, and a shadow auto_approve template on page two would be
  // invisible while the ok is returned on the safe copy.
  it('has_more true: preflight_template_list_paged, even with a passing template on page one', async () => {
    const res = new Response(
      JSON.stringify({ object: 'list', items: FIXTURE_ITEMS, has_more: true, total: 99 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const r = await run(fetchReturning(res));
    expect(r.error?.code).toBe('preflight_template_list_paged');
    expect(r.error?.type).toBe('validation');
    expect(r.data).toBeNull();
  });

  it.each([[false], [undefined], ['true']])('has_more %j does not refuse', async (v) => {
    const body: Record<string, unknown> = { object: 'list', items: FIXTURE_ITEMS, total: 3 };
    if (v !== undefined) body['has_more'] = v;
    const res = new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const r = await run(fetchReturning(res));
    expect(r.error).toBeNull();
  });
});
