// Tests for src/prod-deps.ts (master C13). Proves getDeps() is a true process-wide
// singleton: identity across repeated calls, and identity across two independently
// importing production modules, not just deep-equal copies.
import { describe, it, expect } from 'vitest';
import type { ApprovalContext } from 'eve/tools';
import { getDeps } from '../src/prod-deps.js';
import sendEmailTool from '../agent/tools/send_email.js';
import type { DemoInput } from '../src/build.js';

const RUN_ID = 'prod-deps-cross-module-run';

function makeApprovalCtx(callId: string, toolInput: DemoInput): ApprovalContext<DemoInput> {
  return {
    session: { id: RUN_ID, auth: { current: null, initiator: null }, turn: { id: 't1', sequence: 0 } },
    approvedTools: new Set<string>(),
    callId,
    toolName: 'send_email',
    toolInput,
    getSandbox: async () => { throw new Error('n/a'); },
    getSkill: () => { throw new Error('n/a'); },
  } satisfies ApprovalContext<DemoInput>;
}

describe('getDeps', () => {
  it('returns the same instance on every call (identity, not deep equality)', () => {
    expect(getDeps()).toBe(getDeps());
  });

  it('cross-module: the ledger reached via send_email.ts and via a direct getDeps() call is the same instance', async () => {
    const input: DemoInput = { to: 'user@corp.com', subject: 'Hi', body: 'Body text', audience: 'known' };
    // Append through send_email.ts's OWN import of getDeps(): audience:known takes the
    // auto path, which appends warrant.requested + policy.evaluated + warrant.issued.
    const approval = await sendEmailTool.approval!(makeApprovalCtx('cross-module-call-1', input));
    expect(approval).toBe('approved');

    // Read back through a SEPARATE call to getDeps() from this test file. If send_email.ts
    // held a private ledger instance (the pre-C13 bug: buildDeps() called per caller),
    // this entry would not be visible here and the find() below would come back undefined.
    const runResult = await getDeps().ledger.readRun(RUN_ID);
    expect(runResult.error).toBeNull();
    const requested = runResult.data!.find(e =>
      e.event === 'warrant.requested' &&
      (e.payload as Record<string, unknown>)['requestId'] === 'cross-module-call-1');
    expect(requested).toBeDefined();
  });
});
