// governed-send-email.ts: the ceremony's send_email tool. Identical to src/build.ts's demo tool in
// every respect except its side effect: instead of pushing onto an in-memory array it enqueues one
// governed outbox row, and a separate drainer process sends it (design spec section 8).
//
// WHY THE TOOL DOES NOT CALL AN MTA. A crash between the SMTP handoff and the ledger write would
// leave the proof and reality disagreeing: an email in a stranger's inbox with no action.outcome
// recording it, or an outcome recording a send that never left the building. Neither is survivable
// for a document whose whole purpose is to be trusted. Enqueue-then-drain makes the ledger the
// slower of the two, which is the safe direction.
//
// `params: input` is VERBATIM and must stay verbatim. buildExecute (warrant-eve/src/execute.ts:71)
// hands this function the very object it hashed and compared against warrant.action.paramsHash, and
// the drainer re-hashes whatever it finds in this row. Rebuilding it here as {to, subject, body}
// would work today and would silently start refusing the day the binding grows a field. Section 8
// step 3 says the bytes handed to SMTP are the bytes that were hashed; this line is where that
// stops being a comment.
import { withWarrant } from '@idriszade/warrant-eve';
import type { WarrantEveDeps, Outbox, PlainTool } from '@idriszade/warrant-eve';
import type { EveToolCtx } from '@idriszade/warrant-eve';
import { InputSchema, OutputSchema, gtmBinding } from './build.js';
import type { EmailContent, EmailOutput } from './build.js';

export function buildGovernedSendEmailTool(deps: WarrantEveDeps, outbox: Outbox) {
  // `EmailContent`, not `DemoInput`: what gets enqueued must be what the warrant bound. Typed
  // over the caller's input, `params: input` below would have enqueued `audience` too, a field
  // `toParams` deliberately excludes so the hash stays stable, and the drainer would refuse it
  // as tampering. See `gtmBinding`'s header.
  const plainTool: PlainTool<EmailContent, EmailOutput> = {
    description: 'Send an email on behalf of the outbound GTM agent',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    execute: async (input: EmailContent, ctx: EveToolCtx): Promise<EmailOutput> => {
      const enqueued = await outbox.enqueue({
        requestId: ctx.callId,
        runId: ctx.session.id,
        params: input,
        enqueuedAt: deps.now().toISOString(),
      });
      // Throwing here is correct and is eve's contract for execute. The nonce is already spent by
      // this point (buildExecute appends action.executed BEFORE calling us), so the action can never
      // happen: the run is stuck, not silently sent. Stuck is the fail-closed direction.
      if (enqueued.error) throw new Error(`outbox_${enqueued.error.code}`);
      return { messageId: `queued:${ctx.callId}` };
    },
  };

  return withWarrant(plainTool, gtmBinding, deps);
}
