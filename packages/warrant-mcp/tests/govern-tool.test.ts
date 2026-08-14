/**
 * `governTool` is a caller of the two seams, not a third one: every branch here is either
 * `requestAuthority`'s or `guardedExecute`'s own behaviour, seen through an MCP tool call. The
 * action kind, params and review content below are deliberately MCP-shaped
 * (`{ toolName, arguments }`) rather than eve's email vocabulary: that contrast is the point of
 * the domain-blindness test at the bottom of this file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { err, ok } from '@idriszade/core';
import { generateKeyPair } from '@idriszade/warrant-core';
import type { WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { loadPolicy } from '@idriszade/warrant-policy';
import type { ReviewRequest } from '@idriszade/warrant-gatewerk';
import { governTool } from '../src/index.js';
import type { GovernToolDeps, McpTool, McpToolBinding, McpToolResult } from '../src/index.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG_ROOT, 'src');

const POLICY_YAML = `
version: "1.0.0"
defaults:
  path: deny
stakes:
  - id: tool_sensitive
    match:
      actionKind: call_tool
      audience: sensitive
    path: human
  - id: tool_auto
    match:
      actionKind: call_tool
    path: auto
protectedAudiences:
  - "*.protected"
caps:
  perPrincipalDaily: {}
`.trim();

const KEYS = generateKeyPair('11'.repeat(32));
const AT = new Date('2026-07-30T10:00:00.000Z');
const PRINCIPAL = { kind: 'agent' as const, id: 'agent-1' };

/**
 * **`ToolArgs` and `ToolParams` are deliberately different shapes**, and every fixture below
 * depends on that. An earlier version of this file used `{message}` for both, which made `I` and
 * `T` structurally identical, so `governTool` could hand the handler either one and no test
 * could tell. The field names differ so that a handler reading `body` proves it received the
 * *authorized params*, not the client's arguments.
 */
interface ToolArgs {
  message: string;
}
interface ToolParams {
  body: string;
}

const ParamsSchema = z.object({ body: z.string() });

function makeBinding(overrides: Partial<McpToolBinding<ToolArgs>> = {}): McpToolBinding<ToolArgs> {
  return {
    actionKind: 'call_tool',
    principal: PRINCIPAL,
    toTarget: () => 'svc-a',
    toParams: (args) => ({ body: args.message }),
    toContext: () => ({}),
    toReviewTitle: () => 'Review tool call',
    toReviewContent: (args) => ({ toolName: 'echo', arguments: args }),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GovernToolDeps> = {}): GovernToolDeps {
  const loaded = loadPolicy(POLICY_YAML);
  if (loaded.error) throw new Error('policy load failed: ' + loaded.error.message);
  let tick = 0;
  return {
    policy: loaded.data,
    keys: KEYS,
    publicKeyHex: KEYS.publicKeyHex,
    ledger: new MemoryLedger(),
    now: () => AT,
    newId: () => `id-${++tick}`,
    autoTtlMs: 60_000,
    outcomeStatus: 'completed',
    gate: {
      submit: async () => ok({ reviewId: 'review-1' }),
      fetchDecision: async () => ok({ pending: true } as const),
    },
    ...overrides,
  };
}

function makeTool(handler: McpTool<ToolParams>['handler']): McpTool<ToolParams> {
  return { name: 'echo', handler };
}

describe('governTool: the auto path', () => {
  it('executes the handler and records the certificate in order', async () => {
    const ledger = new MemoryLedger();
    const handler = vi.fn(async (params: ToolParams): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: `echo: ${params.body}` }],
    }));
    const governed = governTool(makeTool(handler), makeBinding(), ParamsSchema, makeDeps({ ledger }));

    const result = await governed.handler({ message: 'hi' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('echo: hi');

    const events = (await ledger.readAll()).data!.map((e) => e.event);
    expect(events).toEqual([
      'warrant.requested',
      'policy.evaluated',
      'warrant.issued',
      'action.executed',
      'action.outcome',
    ]);
  });

  // What executes must be what was authorized. The handler is handed the schema-parsed params
  // the warrant binds, never the client's raw arguments, which is the GhostApproval property
  // seen from the adapter's side. This is the test the original fixtures could not express,
  // because they made `I` and `T` the same shape.
  it('hands the handler the AUTHORIZED params, not the client arguments', async () => {
    const ledger = new MemoryLedger();
    const seen: unknown[] = [];
    const handler = vi.fn(async (params: ToolParams): Promise<McpToolResult> => {
      seen.push(params);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const governed = governTool(makeTool(handler), makeBinding(), ParamsSchema, makeDeps({ ledger }));

    const result = await governed.handler({ message: 'hi' });

    expect(result.isError).toBeUndefined();
    expect(seen).toEqual([{ body: 'hi' }]);
    // The client's argument shape never reaches the handler.
    expect(seen[0]).not.toHaveProperty('message');
  });

  // The constraint this places on a binding author, made explicit rather than left to be
  // discovered. `requestAuthority` hashes `request.action.params` as given; `guardedExecute`
  // parses FIRST and hashes what survives (`guarded-execute.ts:63-69`), because stripping is
  // what makes params final. So a binding emitting a key the schema does not declare produces
  // two different digests and is refused, fail-closed, and the refusal is the schema's fault
  // rather than the guard's. **The fix is always the schema or the binding, never a looser
  // comparison**, a standing prohibition.
  it('refuses fail-closed when the binding emits a key the schema strips', async () => {
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    const binding = makeBinding({ toParams: (args) => ({ body: args.message, sneak: 'extra' }) });
    const governed = governTool(makeTool(handler), binding, ParamsSchema, makeDeps());

    const result = await governed.handler({ message: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('params_mismatch');
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('calls binding.toParams exactly once: the warrant and the guard must hash the same bytes', async () => {
    const toParams = vi.fn((args: ToolArgs) => ({ body: args.message }));
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const governed = governTool(
      makeTool(handler),
      makeBinding({ toParams }),
      ParamsSchema,
      makeDeps(),
    );

    await governed.handler({ message: 'hi' });

    expect(toParams).toHaveBeenCalledTimes(1);
  });
});

describe('governTool: the run a call belongs to', () => {
  it('defaults to one single-action run per call, and uses an injected runId when given one', async () => {
    const perCall = new MemoryLedger();
    const handler = async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'ok' }],
    });
    const governedDefault = governTool(
      makeTool(handler),
      makeBinding(),
      ParamsSchema,
      makeDeps({ ledger: perCall }),
    );
    await governedDefault.handler({ message: 'a' });
    await governedDefault.handler({ message: 'b' });
    const defaultRuns = new Set((await perCall.readAll()).data!.map((e) => e.runId));
    expect(defaultRuns.size).toBe(2);

    const shared = new MemoryLedger();
    const governedSession = governTool(
      makeTool(handler),
      makeBinding(),
      ParamsSchema,
      makeDeps({ ledger: shared, runId: () => 'session-7' }),
    );
    await governedSession.handler({ message: 'a' });
    await governedSession.handler({ message: 'b' });
    expect(new Set((await shared.readAll()).data!.map((e) => e.runId))).toEqual(
      new Set(['session-7']),
    );
  });
});

// The guide's rule, never report a ledger outage and a policy refusal identically, binds the
// *text* in this adapter and not only the branch, because `McpToolResult` has no structured
// error channel and its reader is usually a language model deciding what to tell a person. A
// governance fault rendered as "denied" produces a confident, false claim that the user lacks
// permission. Both cases refuse; only one of them is a decision.
describe('governTool: a refusal and a fault do not read alike', () => {
  it('a policy denial reads as a verdict; an unreachable ledger reads as a fault', async () => {
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));

    const deniedResult = await governTool(
      makeTool(handler),
      makeBinding({ actionKind: 'unmatched_action' }),
      ParamsSchema,
      makeDeps(),
    ).handler({ message: 'hi' });

    // A ledger that refuses every append: requestAuthority cannot complete its sequence.
    const brokenLedger = new MemoryLedger();
    brokenLedger.append = async () =>
      err<WarrantError>({ type: 'transient', code: 'ledger_error', message: 'unreachable' });
    const faultResult = await governTool(
      makeTool(handler),
      makeBinding(),
      ParamsSchema,
      makeDeps({ ledger: brokenLedger }),
    ).handler({ message: 'hi' });

    expect(deniedResult.isError).toBe(true);
    expect(faultResult.isError).toBe(true);
    expect(handler).toHaveBeenCalledTimes(0);

    const deniedText = deniedResult.content[0]?.text ?? '';
    const faultText = faultResult.content[0]?.text ?? '';

    expect(deniedText).toContain('refused by policy');
    expect(faultText).toContain('governance unavailable');
    expect(faultText).toContain('ledger_error');

    // The load-bearing assertion: neither is a prefix of the other's category, so a reader
    // cannot mistake an outage for a refusal by matching the leading words.
    expect(faultText).not.toContain('refused by policy');
    expect(deniedText).not.toContain('governance unavailable');
  });
});

describe('governTool: the deny path', () => {
  it('does not call the handler, and returns isError:true', async () => {
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    // No stakes rule matches this actionKind, so it falls through to defaults.path = deny.
    const binding = makeBinding({ actionKind: 'unmatched_action' });
    const governed = governTool(makeTool(handler), binding, ParamsSchema, makeDeps());

    const result = await governed.handler({ message: 'hi' });

    expect(handler).toHaveBeenCalledTimes(0);
    expect(result.isError).toBe(true);
  });
});

describe('governTool: the human path', () => {
  it('submits to the gate, appends review.submitted, does not call the handler, and mints no warrant', async () => {
    const ledger = new MemoryLedger();
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    const submit = vi.fn(async () => ok({ reviewId: 'review-42' }));
    const binding = makeBinding({ toContext: () => ({ audience: 'sensitive' }) });
    const deps = makeDeps({
      ledger,
      gate: { submit, fetchDecision: async () => ok({ pending: true } as const) },
    });
    const governed = governTool(makeTool(handler), binding, ParamsSchema, deps);

    const result = await governed.handler({ message: 'hi' });

    expect(handler).toHaveBeenCalledTimes(0);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('pending review: review-42');

    const events = (await ledger.readAll()).data!.map((e) => e.event);
    // No warrant.issued: the human path stops at the verdict and returns no warrant.
    expect(events).toEqual(['warrant.requested', 'policy.evaluated', 'review.submitted']);
  });

  it('reports an outage on this path as an outage, not as a denial', async () => {
    // These three lines must never say `denied:`. In MCP the text is the channel: the reader
    // is usually a model deciding what to tell a person, so "denied: ledger_error" would be a
    // confident, false claim that the user lacks permission when the ledger is merely
    // unreachable.
    const sensitive = makeBinding({ toContext: () => ({ audience: 'sensitive' }) });
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));

    // (a) the review gate is unreachable
    const gateDown = await governTool(makeTool(handler), sensitive, ParamsSchema, makeDeps({
      gate: {
        submit: async () => err<WarrantError>({ type: 'transient', code: 'gate_down', message: 'refused' }),
        fetchDecision: async () => ok({ pending: true } as const),
      },
    })).handler({ message: 'hi' });

    // (b) the gate accepts and the ledger cannot record that it did
    const halfBroken = new MemoryLedger();
    const realAppend = halfBroken.append.bind(halfBroken);
    halfBroken.append = async (input) =>
      input.event === 'review.submitted'
        ? err<WarrantError>({ type: 'transient', code: 'ledger_error', message: 'unreachable' })
        : realAppend(input);
    const ledgerDown = await governTool(makeTool(handler), sensitive, ParamsSchema, makeDeps({
      ledger: halfBroken,
    })).handler({ message: 'hi' });

    expect(handler).toHaveBeenCalledTimes(0);
    const gateText = gateDown.content[0]?.text ?? '';
    const ledgerText = ledgerDown.content[0]?.text ?? '';

    // Not vacuous: both actually refused, so the wording assertions have something to read.
    expect(gateDown.isError).toBe(true);
    expect(ledgerDown.isError).toBe(true);

    expect(gateText).toContain('governance unavailable');
    expect(ledgerText).toContain('governance unavailable');

    // The load-bearing half. `denied` is what a model turns into "you are not allowed to do
    // that"; neither of these is a decision about permission, and nothing here was decided.
    expect(gateText).not.toContain('denied');
    expect(ledgerText).not.toContain('denied');
    expect(gateText).not.toContain('refused by policy');
    expect(ledgerText).not.toContain('refused by policy');
  });

  // `GatewerkGate#submit` returns three distinct codes (gatewerk-gate.ts), not one. Collapsing
  // all three into `governance unavailable: gate_unreachable` would make a 400 SSRF
  // rejection, a 401 and a 409 idempotency conflict all read as "the gate is unreachable" while
  // the gate answered promptly and correctly. Category stays fixed at `governance unavailable:`
  // on every branch (a 401 and a genuine timeout both mean no verdict was reached); only the
  // code may name which of the four happened, and each is pinned here so a future collapse
  // fails a test rather than reading clean.
  describe('the code names which submit failure happened, not just that one did', () => {
    async function submitFails(error: WarrantError): Promise<McpToolResult> {
      const sensitive = makeBinding({ toContext: () => ({ audience: 'sensitive' }) });
      const handler = vi.fn(async (): Promise<McpToolResult> => ({
        content: [{ type: 'text', text: 'should not run' }],
      }));
      return governTool(makeTool(handler), sensitive, ParamsSchema, makeDeps({
        gate: {
          submit: async () => err<WarrantError>(error),
          fetchDecision: async () => ok({ pending: true } as const),
        },
      })).handler({ message: 'hi' });
    }

    it('a genuine transport failure names gate_unreachable', async () => {
      const result = await submitFails({ type: 'transient', code: 'gate_unreachable', message: 'timeout' });
      expect(result.content[0]?.text).toBe('governance unavailable: gate_unreachable');
    });

    it('an HTTP refusal names gate_refused, with the status carried through', async () => {
      const result = await submitFails({ type: 'transient', code: 'gatewerk_api_error', message: '409 Conflict' });
      expect(result.content[0]?.text).toBe('governance unavailable: gate_refused: 409 Conflict');
      // Not the transport code, and not worded as a decision.
      expect(result.content[0]?.text).not.toContain('gate_unreachable');
      expect(result.content[0]?.text).not.toContain('refused by policy');
    });

    it('a 2xx with no usable review id names gate_invalid_response', async () => {
      const result = await submitFails({
        type: 'validation', code: 'gatewerk_missing_review_id', message: 'no id',
      });
      expect(result.content[0]?.text).toBe('governance unavailable: gate_invalid_response');
    });

    it('a code this switch does not name falls back to approval_internal_error, not to another branch\'s code', async () => {
      const result = await submitFails({ type: 'transient', code: 'something_else', message: 'huh' });
      expect(result.content[0]?.text).toBe('governance unavailable: approval_internal_error');
    });
  });

  // The duplicate-code collision fixed in warrant-eve/src/approval.ts (`ledger_error` at :45 for
  // requestAuthority vs `review_append_failed` at :92 for review.submitted), second runtime.
  // `requestAuthority`'s own ledger_error (this file's `:79-90`) is a DIFFERENT point in the
  // sequence from the gate having already accepted the review and the append recording that
  // failing, sharing one code made the two indistinguishable to a reader.
  it('a review that cannot be recorded names review_append_failed, not the requestAuthority code', async () => {
    const sensitive = makeBinding({ toContext: () => ({ audience: 'sensitive' }) });
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    const brokenLedger = new MemoryLedger();
    const realAppend = brokenLedger.append.bind(brokenLedger);
    brokenLedger.append = async (input) =>
      input.event === 'review.submitted'
        ? err<WarrantError>({ type: 'transient', code: 'ledger_error', message: 'unreachable' })
        : realAppend(input);
    const result = await governTool(makeTool(handler), sensitive, ParamsSchema, makeDeps({
      ledger: brokenLedger,
      gate: { submit: async () => ok({ reviewId: 'review-1' }), fetchDecision: async () => ok({ pending: true } as const) },
    })).handler({ message: 'hi' });

    expect(result.content[0]?.text).toBe('governance unavailable: review_append_failed');
    // Same category as the requestAuthority ledger_error case, but not the same code: sharing
    // one code across two different points in the sequence is exactly what this pins against.
    expect(result.content[0]?.text).not.toContain('governance unavailable: ledger_error');
    expect(handler).toHaveBeenCalledTimes(0);
  });
});

describe('governTool never rejects', () => {
  it('a handler that throws does not reject the governed handler, and still records action.outcome', async () => {
    const ledger = new MemoryLedger();
    const handler = vi.fn(async (): Promise<McpToolResult> => {
      throw new Error('boom');
    });
    const governed = governTool(makeTool(handler), makeBinding(), ParamsSchema, makeDeps({ ledger }));

    await expect(governed.handler({ message: 'hi' })).resolves.toMatchObject({ isError: true });

    const outcome = (await ledger.readAll()).data!.find((e) => e.event === 'action.outcome');
    expect(outcome).toBeDefined();
    expect((outcome!.payload as Record<string, unknown>)['status']).toBe('failed');
  });

  it('a handler returning isError:true records action.outcome with status:"failed"', async () => {
    const ledger = new MemoryLedger();
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'tool refused: rate limited' }],
      isError: true,
    }));
    const governed = governTool(makeTool(handler), makeBinding(), ParamsSchema, makeDeps({ ledger }));

    const result = await governed.handler({ message: 'hi' });

    // The handler's own text survives: governTool reconstructs the tool result rather than
    // substituting warrant's own wording (adapter's brief: "carrying the handler's original
    // text with isError:true").
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('tool refused: rate limited');

    const outcome = (await ledger.readAll()).data!.find((e) => e.event === 'action.outcome');
    expect((outcome!.payload as Record<string, unknown>)['status']).toBe('failed');
  });
});

// The outer catch is not a fourth governance path: it is what is left over once the other two
// wrap their own failures. `tool.handler` throwing is caught inside `guardedExecute` as
// `effect_threw` (:188-198 hands the effect closure in, and `guardedExecute` catches around it);
// every `requestAuthority` and `guardedExecute` failure above already gets its own typed refusal.
// What can still land here is an adapter author's own bug: `deps.newId()` or a binding's `to*`
// translator throwing, before any governance seam is reached. No test exercised this branch
// before now: `governance_internal_error` had zero hits in this file. Pinned as a literal so a
// future rewording is a deliberate decision, not silent drift, even though, unlike every other
// refusal in this file, this text carries no code, because nothing here can identify which of
// the adapter's own functions was the one that broke.
describe('governTool: the outer catch (an adapter bug, not a governance decision)', () => {
  it('a binding.toTarget that throws surfaces as governance_internal_error', async () => {
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    const binding = makeBinding({
      toTarget: () => {
        throw new Error('adapter bug: toTarget threw');
      },
    });
    const governed = governTool(makeTool(handler), binding, ParamsSchema, makeDeps());

    const result = await governed.handler({ message: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('governance_internal_error');
    expect(handler).toHaveBeenCalledTimes(0);
  });

  it('a deps.newId that throws surfaces as governance_internal_error', async () => {
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));
    const deps = makeDeps({
      newId: () => {
        throw new Error('adapter bug: newId threw');
      },
    });
    const governed = governTool(makeTool(handler), makeBinding(), ParamsSchema, deps);

    const result = await governed.handler({ message: 'hi' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('governance_internal_error');
    expect(handler).toHaveBeenCalledTimes(0);
  });
});

describe('an MCP tool call is not an email', () => {
  it('review content is {toolName, arguments} and flows through Gate.submit unchanged', async () => {
    const ledger = new MemoryLedger();
    const handler = vi.fn(async (): Promise<McpToolResult> => ({
      content: [{ type: 'text', text: 'unused' }],
    }));
    const submit = vi.fn(async (_r: ReviewRequest) => ok({ reviewId: 'review-99' }));
    const args: ToolArgs = { message: 'hi' };
    const expectedContent = { toolName: 'echo', arguments: args };
    const binding = makeBinding({
      toContext: () => ({ audience: 'sensitive' }),
      toReviewContent: () => expectedContent,
    });
    const deps = makeDeps({
      ledger,
      gate: { submit, fetchDecision: async () => ok({ pending: true } as const) },
    });
    const governed = governTool(makeTool(handler), binding, ParamsSchema, deps);

    await governed.handler(args);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].content).toEqual(expectedContent);

    const review = (await ledger.readAll()).data!.find((e) => e.event === 'review.submitted');
    expect((review!.payload as Record<string, unknown>)['content']).toEqual(expectedContent);
  });

  it('declares and imports no MCP vendor SDK, and names no email-shaped field', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(allDeps)).not.toContain('@modelcontextprotocol/sdk');

    const srcText = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(SRC, f), 'utf8'))
      .join('\n');
    expect(srcText).not.toContain('modelcontextprotocol');

    const forbidden = ['subject', 'recipient', 'smtp', 'mailgun', 'resend', 'sendgrid', 'emailcontent'];
    const found = forbidden.filter((w) => srcText.toLowerCase().includes(w));
    expect(found).toEqual([]);
  });
});
