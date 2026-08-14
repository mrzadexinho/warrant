// packages/warrant-authorize/tests/payload-ablation.test.ts
//
// The payload-ablation harness. This codebase's recurring defect class SUCCEEDS
// WRONGLY: a missing value flows through and something mints anyway, rather than
// failing loudly. This file systematically deletes each key, one at a time, from
// the data structures on the authority path (ActionRequest, and one level into its
// nested action/context objects) and asserts that no ablated variant ever reaches
// warrant.issued. Keys are iterated programmatically via Object.keys() over the
// fixture object so a future field on ActionRequest is automatically covered.
//
// Every ablation that still mints is a REAL FINDING, not a test bug: the assertion
// is never weakened to make one pass. Findings are pinned as `test.todo` with a
// `FINDING:` comment carrying the exact key and the verbatim successful result.

import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@idriszade/warrant-core';
import type { ActionRequest } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger } from '@idriszade/warrant-ledger';
import { loadPolicy } from '@idriszade/warrant-policy';
import { requestAuthority } from '../src/index.js';
import type { AuthorizeDeps } from '../src/index.js';

const POLICY_YAML = `
version: "1.0.0"
defaults:
  path: deny
stakes:
  - id: ticket_sensitive
    match:
      actionKind: open_ticket
      audience: sensitive
    path: human
  - id: ticket_auto
    match:
      actionKind: open_ticket
    path: auto
protectedAudiences:
  - "*.protected"
caps:
  perPrincipalDaily: {}
`.trim();

const KEYS = generateKeyPair('22'.repeat(32));
const RUN = 'run-ablation';
const REQ = 'req-ablation';
const PRINCIPAL = { kind: 'agent' as const, id: 'agent-ablation' };
const AT = new Date('2026-08-01T00:00:00.000Z');

function baseRequest(context: Record<string, unknown> = {}): ActionRequest {
  return {
    id: REQ,
    runId: RUN,
    principal: PRINCIPAL,
    action: {
      kind: 'open_ticket',
      target: 'svc-a',
      params: { ticketId: 'INC-99', severity: 2 },
    },
    context,
  };
}

function makeDeps(): AuthorizeDeps {
  const loaded = loadPolicy(POLICY_YAML);
  if (loaded.error) throw new Error('policy load failed: ' + loaded.error.message);
  let tick = 0;
  return {
    policy: loaded.data,
    keys: KEYS,
    ledger: new MemoryLedger(),
    now: () => AT,
    newId: () => `id-${++tick}`,
    autoTtlMs: 60_000,
  };
}

const eventsOf = async (l: Ledger): Promise<string[]> =>
  (await l.readRun(RUN)).data!.map((e) => e.event);

/**
 * The single assertion the whole harness exists to make: whatever ablation was
 * applied, the run must never mint. `path: 'auto'` is the only branch carrying a
 * `warrant`, so checking both the outcome and the ledger closes the two ways an
 * ablation could "succeed wrongly": a returned warrant, or one recorded past the
 * refusal point even if the return value looked like a refusal.
 */
async function ablationResult(
  request: ActionRequest,
  deps: AuthorizeDeps,
): Promise<{ mintedWrongly: boolean; resultSummary: unknown; events: string[] }> {
  const r = await requestAuthority(request, deps);
  const events = await eventsOf(deps.ledger);
  const mintedWrongly = r.data?.path === 'auto' || events.includes('warrant.issued');
  return {
    mintedWrongly,
    events,
    resultSummary: r.error ? { error: r.error } : { data: r.data },
  };
}

describe('payload-ablation: ActionRequest top-level keys', () => {
  const sane = baseRequest();

  // Sanity: the un-ablated fixture actually mints, or every case below would
  // trivially "pass" for the wrong reason: there would be nothing to break.
  it('sanity: the unablated fixture mints on the auto path', async () => {
    const deps = makeDeps();
    const r = await requestAuthority(sane, deps);
    expect(r.data?.path).toBe('auto');
  });

  // Was a FINDING: deleting request.id used to mint a full warrant while every ledger
  // entry carried requestId: undefined, an audit trail that cannot correlate the run
  // back to anything the caller named. Fixed by the boundary parse in requestAuthority;
  // this pin keeps the fix honest.
  it('deleting top-level key "id" is refused as malformed_request, nothing appended', async () => {
    const deps = makeDeps();
    const ablated = { ...sane } as Record<string, unknown>;
    delete ablated['id'];
    const r = await requestAuthority(ablated as ActionRequest, deps);
    expect(r.error?.code).toBe('malformed_request');
    expect((await deps.ledger.readRun(sane.runId)).data).toEqual([]);
  });

  for (const key of Object.keys(sane)) {
    it(`deleting top-level key "${key}" never results in an issued warrant`, async () => {
      const deps = makeDeps();
      const ablated = { ...sane } as Record<string, unknown>;
      delete ablated[key];
      const { mintedWrongly, resultSummary, events } = await ablationResult(
        ablated as ActionRequest,
        deps,
      );
      expect(
        mintedWrongly,
        `deleting "${key}" minted a warrant: ${JSON.stringify(resultSummary)} events=${JSON.stringify(events)}`,
      ).toBe(false);
    });
  }
});

describe('payload-ablation: ActionRequest.action nested keys', () => {
  const sane = baseRequest();

  for (const key of Object.keys(sane.action)) {
    it(`deleting action.${key} never results in an issued warrant`, async () => {
      const deps = makeDeps();
      const action = { ...sane.action } as Record<string, unknown>;
      delete action[key];
      const ablated = { ...sane, action } as unknown as ActionRequest;
      const { mintedWrongly, resultSummary, events } = await ablationResult(ablated, deps);
      expect(
        mintedWrongly,
        `deleting action.${key} minted a warrant: ${JSON.stringify(resultSummary)} events=${JSON.stringify(events)}`,
      ).toBe(false);
    });
  }
});

describe('payload-ablation: ActionRequest.context nested keys gate the human path', () => {
  // A context whose fields are load-bearing for stakes routing: `audience` is what
  // sends this request to human review instead of auto-mint. This is the case the
  // harness exists for: deleting a gating field must never loosen the outcome.
  const gatingContext = { audience: 'sensitive', sentTodayByKind: { open_ticket: 2 } };
  const sane = baseRequest(gatingContext);

  it('sanity: the unablated gating context routes to human, not auto', async () => {
    const deps = makeDeps();
    const r = await requestAuthority(sane, deps);
    expect(r.data?.path).toBe('human');
  });

  // RULED (was a FINDING): deleting context.audience reroutes human -> auto UNDER THIS
  // TEST'S OWN POLICY DOC, because its ticket_auto rule matches on actionKind alone: an
  // authored catch-all reachable by omitting every narrowing key. That is a
  // POLICY-AUTHORING footgun, not an engine defect: a rule requiring a key on an absent
  // key correctly does not match, and what a fall-through reaches is whatever the author
  // put beneath it. The shipped pack has no such catch-all (absent audience on send_email
  // hits default deny; pinned in warrant-pack-gtm/tests/absent-audience.test.ts), and the
  // footgun is documented in warrant-policy's README. This test asserts the semantics so
  // any change to them is a visible decision.
  it('deleting context.audience under a catch-all auto rule reroutes to auto: the documented authoring footgun', async () => {
    const deps = makeDeps();
    const context = { ...gatingContext } as Record<string, unknown>;
    delete context['audience'];
    const r = await requestAuthority({ ...sane, context } as ActionRequest, deps);
    expect(r.data?.path).toBe('auto');
    expect(r.data?.verdict.ruleId).toBe('ticket_auto');
  });

  for (const key of Object.keys(gatingContext).filter((k) => k !== 'audience')) {
    it(`deleting context.${key} never results in an issued warrant`, async () => {
      const deps = makeDeps();
      const context = { ...gatingContext } as Record<string, unknown>;
      delete context[key];
      const ablated = { ...sane, context } as ActionRequest;
      const { mintedWrongly, resultSummary, events } = await ablationResult(ablated, deps);
      expect(
        mintedWrongly,
        `deleting context.${key} minted a warrant: ${JSON.stringify(resultSummary)} events=${JSON.stringify(events)}`,
      ).toBe(false);
    });
  }
});
