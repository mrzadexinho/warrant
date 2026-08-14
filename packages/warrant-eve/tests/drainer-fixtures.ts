// drainer-fixtures.ts: shared setup for the two drainer suites (drainer.test.ts and
// drainer-batch.test.ts). Warrants here are genuinely signed by issueWarrant/generateKeyPair
// and read back through a real MemoryLedger, so every refusal is measured against a document
// the verifier would actually accept or reject. Imported relatively by test files ONLY, and
// never from src/index.ts: vitest code must not enter the production surface.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import { generateKeyPair, issueWarrant, paramsHash } from '@idriszade/warrant-core';
import type { Principal, Warrant, WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
import { MemoryOutbox, DEFAULT_OUTBOX_LIMIT } from '../src/outbox.js';
import type { DrainerLock, Sender } from '../src/outbox.js';
import { drainOutbox } from '../src/drainer.js';
import type { DrainerDeps } from '../src/drainer.js';

export const KEYS = generateKeyPair('33'.repeat(32));
export const OTHER_KEYS = generateKeyPair('44'.repeat(32));
export const NOW = new Date('2026-07-28T10:00:00.000Z');
export const RUN = 'run-1';
export const REQ = 'call-1';
export const PRINCIPAL: Principal = { kind: 'agent', id: 'agent-outbound' };
export const PARAMS = { to: 'prospect@example.com', subject: 'Intro', body: 'Hello there' };

export function mkWarrant(o: {
  keys?: { publicKeyHex: string; privateKeyHex: string };
  runId?: string; requestId?: string; issuedAt?: Date; ttlMs?: number;
} = {}): Warrant {
  let tick = 0;
  const r = issueWarrant(
    {
      request: {
        id: o.requestId ?? REQ, runId: o.runId ?? RUN, principal: PRINCIPAL,
        action: { kind: 'send_email', target: PARAMS.to, params: PARAMS }, context: {},
      },
      verdict: { path: 'auto', ruleId: 'send_email_auto', policyVersion: '1.0.0', policyHash: 'ph', reason: 'auto' },
      ttlMs: o.ttlMs ?? 3_600_000,
    },
    { keys: o.keys ?? KEYS, now: () => o.issuedAt ?? NOW, newId: () => `w-${++tick}` },
  );
  if (r.error) throw new Error('fixture: ' + r.error.code);
  return r.data;
}

export async function seedLedger(o: {
  warrant?: Warrant; issued?: number; executedWarrantId?: string | null; outcomeStatuses?: string[];
  // Only the multi-row cases override these; every other test keeps the single REQ/RUN fixture.
  requestId?: string; runId?: string;
} = {}): Promise<{ ledger: MemoryLedger; w: Warrant }> {
  const runId = o.runId ?? RUN;
  const requestId = o.requestId ?? REQ;
  const w = o.warrant ?? mkWarrant({ runId, requestId });
  const ledger = new MemoryLedger();
  const at = NOW.toISOString();
  for (let i = 0; i < (o.issued ?? 1); i++) {
    await ledger.append({ runId, at, event: 'warrant.issued', principal: PRINCIPAL,
      payload: { requestId, warrantId: w.id, warrant: w } });
  }
  const execId = o.executedWarrantId === undefined ? w.id : o.executedWarrantId;
  if (execId !== null) {
    await ledger.append({ runId, at, event: 'action.executed', principal: PRINCIPAL,
      payload: { requestId, warrantId: execId, nonce: w.nonce } });
  }
  for (const status of o.outcomeStatuses ?? []) {
    await ledger.append({ runId, at, event: 'action.outcome', principal: PRINCIPAL,
      payload: { requestId, warrantId: w.id, status } });
  }
  return { ledger, w };
}

export function makeSender(behaviour: 'ok' | 'err' | 'throw' = 'ok'): { sender: Sender<unknown>; calls: unknown[] } {
  const calls: unknown[] = [];
  const sender: Sender<unknown> = {
    async send(params: unknown) {
      calls.push(params);
      if (behaviour === 'throw') throw new Error('smtp exploded');
      if (behaviour === 'err') return err({ type: 'transient', code: 'smtp_unreachable', message: 'no route' });
      return ok({ messageId: 'msg-1' });
    },
  };
  return { sender, calls };
}

export function makeLock(outcome: boolean | 'throw'): { lock: DrainerLock; calls: { acquire: number; release: number } } {
  const calls = { acquire: 0, release: 0 };
  return {
    calls,
    lock: {
      async acquire() {
        calls.acquire += 1;
        if (outcome === 'throw') throw new Error('lock exploded');
        return outcome;
      },
      async release() { calls.release += 1; },
    },
  };
}

export function makeDeps(ledger: Ledger, o: { publicKeyHex?: string; now?: () => Date } = {}): DrainerDeps {
  return {
    ledger,
    publicKeyHex: o.publicKeyHex ?? KEYS.publicKeyHex,
    now: o.now ?? (() => NOW),
    principal: PRINCIPAL,
  };
}

export async function makeOutbox(params: unknown = PARAMS, runId: string = RUN): Promise<MemoryOutbox> {
  const outbox = new MemoryOutbox();
  await outbox.enqueue({ requestId: REQ, runId, params, enqueuedAt: NOW.toISOString() });
  return outbox;
}

export async function drain(
  ledger: Ledger, sender: Sender<unknown>,
  o: { params?: unknown; runId?: string; publicKeyHex?: string; lock?: DrainerLock } = {},
) {
  const outbox = await makeOutbox(o.params ?? PARAMS, o.runId ?? RUN);
  return drainOutbox(makeDeps(ledger, o), { outbox, sender, ...(o.lock ? { lock: o.lock } : {}) });
}

export async function entriesOf(ledger: MemoryLedger): Promise<LedgerEntry[]> {
  return (await ledger.readRun(RUN)).data!;
}

export async function outcomesOf(ledger: MemoryLedger): Promise<Record<string, unknown>[]> {
  return (await entriesOf(ledger))
    .filter(e => e.event === 'action.outcome')
    .map(e => e.payload as Record<string, unknown>);
}

// A ledger whose reads work but whose action.outcome appends fail. Everything else passes
// through to a real MemoryLedger so the drainer still sees a genuine chain.
export class OutcomeFailingLedger implements Ledger {
  constructor(private readonly inner: MemoryLedger, private readonly mode: 'err' | 'throw') {}
  async append(input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> {
    if (input.event === 'action.outcome') {
      if (this.mode === 'throw') throw new Error('ledger exploded');
      return err({ type: 'transient', code: 'db_error', message: 'append refused' });
    }
    return this.inner.append(input);
  }
  readRun(runId: string) { return this.inner.readRun(runId); }
  readAll() { return this.inner.readAll(); }
}

// A ledger that cannot be read. `append` throws so that any write attempt escapes loudly
// instead of being mistaken for "no ledger write happened".
export class ReadFailingLedger implements Ledger {
  constructor(private readonly mode: 'err' | 'throw') {}
  async append(_input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> {
    throw new Error('drainer must not append when the run cannot be read');
  }
  async readRun(_runId: string): Promise<Result<LedgerEntry[], WarrantError>> {
    if (this.mode === 'throw') throw new Error('connection reset');
    return err({ type: 'transient', code: 'db_error', message: 'read refused' });
  }
  readAll() { return this.readRun(''); }
}
