import { z } from 'zod';
import { generateKeyPair } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { SimGate } from '@idriszade/warrant-gatewerk';
import { defaultGtmPolicy } from '@idriszade/warrant-pack-gtm';
import { withWarrant, MemoryParkStore } from '@idriszade/warrant-eve';
import type { WarrantEveDeps, WarrantToolBinding, PlainTool } from '@idriszade/warrant-eve';

// GTM policy: send_email+audience:known → auto, audience:cold → human, *@*.gov + press@* → deny
const DEMO_KEYS = generateKeyPair('22'.repeat(32));

export type EmailContent = { to: string; subject: string; body: string };
export type DemoInput = EmailContent & { audience?: string };
export type EmailOutput = { messageId: string };

export function buildDeps(overrides?: Partial<WarrantEveDeps>): WarrantEveDeps {
  let tick = 0;
  return {
    policy: defaultGtmPolicy(),
    keys: DEMO_KEYS,
    publicKeyHex: DEMO_KEYS.publicKeyHex,
    ledger: new MemoryLedger(),
    gate: new SimGate([]),
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    newId: () => `demo-id-${++tick}`,
    autoTtlMs: 60_000,
    humanTtlMs: 3_600_000,
    reviewTimeoutMs: 3_600_000,
    parkStore: new MemoryParkStore(),
    ...overrides,
  };
}

export const InputSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  audience: z.string().optional(),
});

export const OutputSchema = z.object({ messageId: z.string() });

// Lifted to module scope and exported so the ceremony's governed tool (src/governed-send-email.ts)
// shares this EXACT binding rather than declaring its own. toParams is what warrant.action.paramsHash
// is taken over; two bindings that drifted by one field would produce a hash the drainer refuses,
// and the failure would look like tampering rather than like a duplicated literal.
// **`EmailContent`, not `DemoInput`, and the second parameter is the point.** `toParams` drops
// `audience`, which is context-only: it decides the verdict, it is not part of what gets sent.
// Left as `WarrantToolBinding<DemoInput>` this compiled anyway, because `P` defaulted to `I` and
// `{to, subject, body}` structurally satisfies `DemoInput` when `audience` is optional. So the
// handler's type said it might read a field the warrant never bound, and nothing objected: the
// new typing catches a dropped **required** field and cannot catch a dropped **optional** one.
// Naming `P` is what closes that here: the handler is now typed over exactly the bytes the
// warrant binds, so reading `audience` inside it is a compile error rather than `undefined`.
export const gtmBinding: WarrantToolBinding<DemoInput, EmailContent> = {
  actionKind: 'send_email',
  principal: { kind: 'agent', id: 'warrant-eve-outbound' },
  toTarget: (i) => i.to,
  // audience is context-only: NOT included in params (so params hash is stable)
  toParams: (i) => ({ to: i.to, subject: i.subject, body: i.body }),
  toContext: (i) => ({ audience: i.audience }),
  toReviewTitle: (i) => `Review outbound email to ${i.to}`,
  toReviewContent: (i) => ({ subject: i.subject, body: i.body, to: i.to }),
};

export function buildSendEmailTool(
  deps: WarrantEveDeps,
  outbox: EmailContent[] = [],
) {
  // `EmailContent`: the handler receives the authorized params, not the caller's input.
  const plainTool: PlainTool<EmailContent, EmailOutput> = {
    description: 'Send an email on behalf of the outbound GTM agent',
    // `inputSchema` still describes the CALLER's input: that is the I side, and it keeps
    // `audience`, which the policy reads through `toContext`.
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    execute: (input: EmailContent) => {
      const content: EmailContent = { to: input.to, subject: input.subject, body: input.body };
      outbox.push(content);
      return { messageId: `sent-${outbox.length}` };
    },
  };

  return withWarrant(plainTool, gtmBinding, deps);
}
