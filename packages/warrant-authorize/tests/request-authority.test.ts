/**
 * The authorization seam. Every branch is a fail-closed decision, so every branch is a test
 * rather than a comment.
 *
 * The action here is a ticket, not anything a shipping adapter would recognise. This package's
 * own tests must be expressible for a runtime it has never heard of, or "runtime-blind" is a
 * claim rather than a property.
 */

import { describe, expect, it, vi } from 'vitest';
import { err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { canonicalJson, generateKeyPair, sha256Hex, verifyWarrant } from '@idriszade/warrant-core';
import type { ActionRequest, WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
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

const KEYS = generateKeyPair('11'.repeat(32));
const RUN = 'run-1';
const REQ = 'req-1';
const PRINCIPAL = { kind: 'agent' as const, id: 'agent-1' };
const AT = new Date('2026-07-18T10:00:00.000Z');

function makeRequest(
  opts: { target?: string; context?: Record<string, unknown>; kind?: string; params?: unknown } = {},
): ActionRequest {
  return {
    id: REQ,
    runId: RUN,
    principal: PRINCIPAL,
    action: {
      kind: opts.kind ?? 'open_ticket',
      target: opts.target ?? 'svc-a',
      params: opts.params ?? { ticketId: 'INC-42', severity: 3 },
    },
    context: opts.context ?? {},
  };
}

function makeDeps(overrides: Partial<AuthorizeDeps> = {}): AuthorizeDeps {
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
    ...overrides,
  };
}

const eventsOf = async (l: Ledger): Promise<string[]> =>
  (await l.readRun(RUN)).data!.map((e) => e.event);

const payloadOf = async (l: Ledger, event: string): Promise<Record<string, unknown>> => {
  const found = (await l.readRun(RUN)).data!.find((e) => e.event === event);
  return (found?.payload ?? {}) as Record<string, unknown>;
};

/** A ledger that refuses one named event and passes everything else through. */
// The cause is parameterised: a hardcoded `transient`/`db_down` cause would make "carries the
// cause's type" and "always says transient" indistinguishable. Defaults preserve the original
// behaviour so every existing case is unchanged.
function failAppendOf(
  base: MemoryLedger,
  event: string,
  cause: Partial<WarrantError> = {},
): Ledger {
  const e: WarrantError = {
    type: cause.type ?? 'transient',
    code: cause.code ?? 'db_down',
    message: cause.message ?? `stub: ${cause.code ?? 'db_down'} on ${event}`,
  };
  return {
    append: async (i: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> =>
      i.event === event ? err(e) : base.append(i),
    readRun: (id: string) => base.readRun(id),
    readAll: () => base.readAll(),
  };
}

describe('requestAuthority: the auto path', () => {
  it('records request, evaluation and warrant, in that order, and returns the warrant', async () => {
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error).toBeNull();
    expect(r.data!.path).toBe('auto');
    expect(r.data!.verdict.ruleId).toBe('ticket_auto');
    // Order is the invariant, not merely membership: a run holding a verdict before the
    // request it judged cannot be replayed against the policy that produced it.
    expect(await eventsOf(deps.ledger)).toEqual([
      'warrant.requested',
      'policy.evaluated',
      'warrant.issued',
    ]);
  });

  it('returns a warrant that actually verifies against the injected keys', async () => {
    // Otherwise this could hand back any object shaped like a warrant and every assertion
    // above would still pass.
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest(), deps);
    const outcome = r.data!;
    if (outcome.path !== 'auto') throw new Error('expected the auto path');

    expect(verifyWarrant(outcome.warrant, KEYS.publicKeyHex, AT).error).toBeNull();
    expect(outcome.warrant.runId).toBe(RUN);
    expect(outcome.warrant.verdictPath).toBe('auto');
  });

  it('records the same warrant it returned, under warrantId', async () => {
    // The actuator re-reads its authority from the ledger. A returned warrant that is not the
    // recorded one is a token nothing downstream can find.
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest(), deps);
    const outcome = r.data!;
    if (outcome.path !== 'auto') throw new Error('expected the auto path');

    const issued = await payloadOf(deps.ledger, 'warrant.issued');
    expect(issued['requestId']).toBe(REQ);
    expect(issued['warrantId']).toBe(outcome.warrant.id);
    expect(issued['warrant']).toEqual(outcome.warrant);
  });
});

describe('requestAuthority: the human path stops at the verdict', () => {
  it('returns human without issuing a warrant or recording a review', async () => {
    // The whole boundary claim, as an assertion: this function owns the proof spine and
    // nothing else. A review appended here would mean it had learned what review content is.
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest({ context: { audience: 'sensitive' } }), deps);

    expect(r.error).toBeNull();
    expect(r.data!.path).toBe('human');
    expect(r.data!.verdict.ruleId).toBe('ticket_sensitive');
    expect(await eventsOf(deps.ledger)).toEqual(['warrant.requested', 'policy.evaluated']);
  });

  it('has no warrant on the human outcome, so a caller cannot act on one by accident', () => {
    // A type-level property, asserted at runtime too: the human variant carries no warrant
    // field at all rather than an undefined one.
    const outcome = { path: 'human' as const, verdict: {} as never };
    expect(Object.keys(outcome)).toEqual(['path', 'verdict']);
  });
});

describe('requestAuthority: the deny path', () => {
  it('records warrant.denied naming the rule, and returns deny rather than an error', async () => {
    // A refusal is a successful authorization decision: the sequence ran and the ledger says
    // so. Only a failure to PERFORM the sequence is an err.
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest({ kind: 'drop_database' }), deps);

    expect(r.error).toBeNull();
    expect(r.data!.path).toBe('deny');
    expect(await eventsOf(deps.ledger)).toEqual([
      'warrant.requested',
      'policy.evaluated',
      'warrant.denied',
    ]);
    const denied = await payloadOf(deps.ledger, 'warrant.denied');
    expect(denied['reason']).toBe('policy_denied:' + r.data!.verdict.ruleId);
  });

  it('denies a protected audience, so the real engine is wired and not a stub', async () => {
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest({ target: 'agency.protected' }), deps);

    expect(r.data!.path).toBe('deny');
    expect(r.data!.verdict.ruleId).toBe('protected-audience');
  });
});

describe('requestAuthority: the context binding', () => {
  it('records a contextHash that reproduces the recorded context', async () => {
    // evaluate() is pure over (request, policy), so a verdict that depends on context is only
    // re-derivable from the ledger if the ledger ties the two together. The verifier
    // recomputes exactly this.
    const context = { audience: 'known', sentTodayByKind: { open_ticket: 2 } };
    const deps = makeDeps();
    await requestAuthority(makeRequest({ context }), deps);

    const evaluated = await payloadOf(deps.ledger, 'policy.evaluated');
    expect(evaluated['contextHash']).toBe(sha256Hex(canonicalJson(context)));
    expect((await payloadOf(deps.ledger, 'warrant.requested'))['context']).toEqual(context);
  });

  it('refuses a context canonicalJson rejects, by name, before writing anything', async () => {
    // Computed before the first append on purpose. Left later, the payload canonicalisation
    // inside entryHash throws on the same value and the operator is told the adapter broke
    // rather than that their context is unhashable.
    const deps = makeDeps();
    const r = await requestAuthority(makeRequest({ context: { at: new Date(AT) } }), deps);

    expect(r.error?.code).toBe('context_noncanonical');
    expect((await deps.ledger.readRun(RUN)).data).toHaveLength(0);
  });
});

describe('requestAuthority fails closed on every append it cannot make', () => {
  const cases: Array<[string, string]> = [
    ['warrant.requested', 'open_ticket'],
    ['policy.evaluated', 'open_ticket'],
    ['warrant.denied', 'drop_database'],
    ['warrant.issued', 'open_ticket'],
  ];

  it.each(cases)('a failed %s append returns ledger_error and never records it', async (event, kind) => {
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, event) });

    const r = await requestAuthority(makeRequest({ kind }), deps);

    expect(r.error?.code).toBe('ledger_error');
    expect(r.data).toBeNull();
    expect(await eventsOf(base)).not.toContain(event);
  });

  it('a failed warrant.issued append does not hand back a warrant nobody can find', async () => {
    // The one with a real hole behind it. Returning ok here would give the caller a warrant
    // while the ledger holds no record of it, and the actuator reads its authority from the
    // ledger, so the action would fail later, for a reason nobody could diagnose.
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'warrant.issued') });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('ledger_error');
  });

  // `type` is the retry semantics. `Ledger.append` produces more than one: `postgres.ts` emits
  // `noncanonical_payload` as `integrity` and `db_error` as `transient`, both reachable here.
  //
  // Relabelling the first as the second is not a lost diagnosis, it is an INVERTED retry hint:
  // permanent, caller-side, structural fault handed to two runtimes dressed as worth retrying, and
  // a caller that retries it unchanged can never succeed.
  it('carries an integrity cause through as integrity, never relabelling it transient', async () => {
    const base = new MemoryLedger();
    const deps = makeDeps({
      ledger: failAppendOf(base, 'warrant.requested', {
        type: 'integrity',
        code: 'noncanonical_payload',
      }),
    });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error?.type).toBe('integrity');
    // The category is still truthful and still the thing both runtimes switch on; only `type` moved.
    expect(r.error?.code).toBe('ledger_error');
    // The cause's own code is not load-bearing for any switch, but it is the first thing an
    // operator reads, so it must survive into the message rather than being dropped.
    expect(r.error?.message).toContain('noncanonical_payload');
  });

  it('still reports a transient cause as transient, so the fix did not just invert the constant', async () => {
    const base = new MemoryLedger();
    const deps = makeDeps({
      ledger: failAppendOf(base, 'warrant.requested', { type: 'transient', code: 'db_error' }),
    });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error?.type).toBe('transient');
    expect(r.error?.code).toBe('ledger_error');
    expect(r.error?.message).toContain('db_error');
  });

  // Both arms above matter together: asserting only the integrity case would pass against a helper
  // that hardcoded `'integrity'`, which is the same defect with the constant changed. The pair is
  // what makes "carries the cause's type" the only implementation that satisfies it.
  it.each([
    ['integrity', 'noncanonical_payload'],
    ['transient', 'db_error'],
    ['validation', 'bad_input'],
    ['permanent', 'schema_gone'],
  ] as const)('carries a %s cause through unchanged', async (type, code) => {
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'policy.evaluated', { type, code }) });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error?.type).toBe(type);
    expect(r.error?.message).toContain(code);
  });

  it('stops at the first failure rather than continuing the sequence', async () => {
    const base = new MemoryLedger();
    const deps = makeDeps({ ledger: failAppendOf(base, 'warrant.requested') });

    await requestAuthority(makeRequest(), deps);

    expect(await eventsOf(base)).toEqual([]);
  });
});

describe('requestAuthority fails closed when a warrant cannot be minted', () => {
  it('returns issue_failed rather than approving, and records no warrant', async () => {
    const deps = makeDeps({ keys: { privateKeyHex: 'not-a-key', publicKeyHex: KEYS.publicKeyHex } });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error?.code).toBe('issue_failed');
    expect(await eventsOf(deps.ledger)).not.toContain('warrant.issued');
  });
});

describe('requestAuthority can never throw', () => {
  it('resolves authorize_internal_error when the ledger throws instead of returning', async () => {
    // A caller may be an approval callback, where a rejected promise is a fail-open: the
    // runtime sees a broken adapter rather than a refusal, and what happens next is its guess.
    const thrower: Ledger = {
      append: async () => { throw new Error('ledger exploded'); },
      readRun: async () => { throw new Error('ledger exploded'); },
      readAll: async () => { throw new Error('ledger exploded'); },
    };
    const deps = makeDeps({ ledger: thrower });

    const r = await requestAuthority(makeRequest(), deps);

    expect(r.error?.code).toBe('authorize_internal_error');
    expect(r.error?.message).toContain('ledger exploded');
  });

  it('resolves rather than rejecting when the clock throws', async () => {
    const deps = makeDeps({ now: () => { throw new Error('clock exploded'); } });

    await expect(requestAuthority(makeRequest(), deps)).resolves.toMatchObject({
      error: { code: 'authorize_internal_error' },
    });
  });

  it('resolves rather than rejecting when newId throws on the auto path', async () => {
    // issueWarrant catches its own throws, so this lands as issue_failed rather than the
    // catch-all. Asserted so the difference is deliberate rather than incidental.
    const deps = makeDeps({ now: () => AT, newId: () => { throw new Error('id exploded'); } });

    const r = await requestAuthority(makeRequest(), deps);
    expect(r.error?.code).toBe('issue_failed');
  });
});

describe('requestAuthority takes the request as given', () => {
  it('never consults a binding, a target builder or any caller callback', async () => {
    // The request arrives fully built. Anything this function called back into would be a
    // seam through which a runtime could reach it.
    const deps = makeDeps();
    const spy = vi.fn();
    const request = makeRequest();
    Object.defineProperty(request, 'toParams', { value: spy, enumerable: false });

    await requestAuthority(request, deps);

    expect(spy).not.toHaveBeenCalled();
  });

  it('appends under the request principal and runId, not a separately supplied one', async () => {
    // Two sources for "who asked" is a hole, and replay correlates on this one.
    const deps = makeDeps();
    await requestAuthority(makeRequest(), deps);

    const entries = (await deps.ledger.readRun(RUN)).data!;
    expect(entries.every((e) => e.runId === RUN)).toBe(true);
    expect(entries.every((e) => JSON.stringify(e.principal) === JSON.stringify(PRINCIPAL))).toBe(true);
  });
});
