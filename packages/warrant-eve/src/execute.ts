import type { ToolContext } from 'eve/tools';
import type { Warrant } from '@idriszade/warrant-core';
import { verifyAuthorizedParams } from '@idriszade/warrant-guard';
import type { WarrantEveDeps, WarrantToolBinding } from './deps.js';

/**
 * A tool, named by what its handler receives.
 *
 * **`P`, not `I`.** The handler runs on the *authorized params*: `binding.toParams(input)` on
 * the auto path, or the reviewer's edited params read back off the ledger on the human one,
 * never on the caller's raw input. This interface is warrant's own (nothing but `ToolContext`
 * comes from `eve/tools`), so nothing outside this repo forces the two to be conflated.
 */
interface ToolLike<P, O> {
  execute: (params: P, ctx: ToolContext) => Promise<O> | O;
}

export function buildExecute<I, P, O>(
  tool: ToolLike<P, O>,
  binding: WarrantToolBinding<I, P>,
  deps: WarrantEveDeps,
): (input: I, ctx: ToolContext) => Promise<O> {
  return async (input: I, ctx: ToolContext): Promise<O> => {
    // Step 1: read run and find the warrant.issued entry for this callId
    const read = await deps.ledger.readRun(ctx.session.id);
    if (read.error) throw new Error('ledger_read_error');

    const entries = read.data;
    const issuedEntries = entries.filter(
      e =>
        e.event === 'warrant.issued' &&
        typeof e.payload === 'object' &&
        e.payload !== null &&
        (e.payload as Record<string, unknown>)['requestId'] === ctx.callId,
    );
    if (issuedEntries.length !== 1) throw new Error('warrant_missing');

    const issuedEntry = issuedEntries[0]!;
    const payload = issuedEntry.payload as Record<string, unknown>;
    const w = payload['warrant'] as Warrant;
    const authorized = payload['authorized'] as unknown | undefined;

    // Steps 2 and 3: verify the warrant (which also parses/validates the Warrant shape), check
    // the run, and compare the params hash. One call to the shared primitive in
    // @idriszade/warrant-guard rather than a third copy of that sequence: the surrounding
    // shape here is eve's (throws, no Zod parse, best-effort outcome), the security core is not.
    //
    // [MED fix #2] runId is a signed field, checked explicitly even though readRun filters by
    // session.id. A cross-session tamper (stub readRun returning a different run's warrant) would
    // otherwise silently pass. That is what expectedRunId carries.
    //
    // No Zod parse before the hash, deliberately: with no stripping, the exact bytes must hash to
    // the signed hash, so an injected key fails the compare rather than being silently dropped.
    // `authorized` is JSON read back off the ledger, so it arrives as `unknown` and this package
    // has no schema to parse it with: `PlainTool.inputSchema` is deliberately opaque. The
    // assertion is about provenance, not shape: these exact bytes are re-hashed and compared
    // against the signed warrant on the very next line, so the handler can only ever see what was
    // authorized. That is a different claim from the `params as I` this replaced, which asserted
    // the handler receives the *caller's input*, the thing that is not true on either path.
    const params: P = authorized !== undefined ? (authorized as P) : binding.toParams(input);
    const authority = verifyAuthorizedParams(w, params, {
      publicKeyHex: deps.publicKeyHex,
      now: deps.now,
      expectedRunId: ctx.session.id,
    });
    if (authority.error) {
      const { code } = authority.error;
      if (code === 'run_mismatch') throw new Error('warrant_run_mismatch');
      if (code === 'params_noncanonical' || code === 'params_mismatch') throw new Error(code);
      throw new Error('warrant_' + code);
    }

    // [MED fix #3] target invariant, auto path only (authorized path is Task 4)
    if (authorized === undefined && binding.toTarget(input) !== w.action.target) {
      throw new Error('target_mismatch');
    }

    // Step 4: append action.executed (nonce spend, fail-closed before side-effect)
    const runId = ctx.session.id;
    const appendExecuted = await deps.ledger.append({
      runId,
      at: deps.now().toISOString(),
      event: 'action.executed',
      principal: binding.principal,
      payload: { requestId: ctx.callId, warrantId: w.id, nonce: w.nonce },
    });
    if (appendExecuted.error) throw new Error('execute_' + appendExecuted.error.code);

    // Step 5: run the actual tool
    const out = await tool.execute(params, ctx);

    // Step 6: append action.outcome (best-effort, do NOT throw if this fails)
    await deps.ledger.append({
      runId,
      at: deps.now().toISOString(),
      event: 'action.outcome',
      principal: binding.principal,
      payload: { requestId: ctx.callId, warrantId: w.id, status: 'queued' },
    });

    return out;
  };
}
