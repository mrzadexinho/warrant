// drainer.test.ts: the governed drainer's send path and the refusals that record an outcome.
// Skips, failure modes, batch behaviour and the lock live in drainer-batch.test.ts; shared setup
// is drainer-fixtures.ts. Split because one file crossed the 400-line test limit.
import { describe, it, expect } from 'vitest';
import { paramsHash } from '@idriszade/warrant-core';
import type { Warrant } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger } from '@idriszade/warrant-ledger';
import { MemoryOutbox, DEFAULT_OUTBOX_LIMIT } from '../src/outbox.js';
import { drainOutbox } from '../src/drainer.js';
import {
  KEYS, OTHER_KEYS, NOW, RUN, REQ, PRINCIPAL, PARAMS,
  mkWarrant, seedLedger, makeSender, makeLock, makeDeps, makeOutbox, drain,
  entriesOf, outcomesOf, OutcomeFailingLedger, ReadFailingLedger,
} from './drainer-fixtures.js';


describe('drainOutbox: the send path', () => {
  it('sends once and appends action.outcome{status:sent, messageId}', async () => {
    const { ledger, w } = await seedLedger();
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'sent', messageId: 'msg-1' }]);
    expect(calls).toHaveLength(1);
    expect(await outcomesOf(ledger)).toEqual([
      { requestId: REQ, warrantId: w.id, status: 'sent', messageId: 'msg-1' },
    ]);
  });

  // The positive form of the §8 step-3 property, and the only test that can see a drainer
  // which hashes one object and hands a re-rendered one to SMTP: recompute the hash over the
  // argument the sender actually received.
  it('the bytes handed to the sender are the bytes that were hashed into the warrant', async () => {
    const { ledger, w } = await seedLedger();
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.data![0]!.status).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(paramsHash(calls[0])).toBe(w.action.paramsHash);
  });

  // A ledger entry whose payload is null is a plain object away from crashing every scan the
  // drainer does. The scans are event-filtered first, so the entry has to be on an event the
  // drainer actually reads for this to bite.
  it('tolerates a scanned ledger entry whose payload is null', async () => {
    const { ledger } = await seedLedger();
    await ledger.append({ runId: RUN, at: NOW.toISOString(), event: 'action.outcome',
      principal: PRINCIPAL, payload: null });
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'sent', messageId: 'msg-1' }]);
    expect(calls).toHaveLength(1);
  });

  it('drains the same outbox twice and sends exactly once', async () => {
    const { ledger } = await seedLedger();
    const { sender, calls } = makeSender();
    const outbox = await makeOutbox();
    const first = await drainOutbox(makeDeps(ledger), { outbox, sender });
    const second = await drainOutbox(makeDeps(ledger), { outbox, sender });
    expect(first.data).toEqual([{ requestId: REQ, status: 'sent', messageId: 'msg-1' }]);
    // Empty, not already_terminal: a sent row is retired, because the ledger now carries its
    // outcome and leaving it would occupy one of the LIMIT slots forever.
    expect(second.data).toEqual([]);
    expect((await outbox.listPending()).data).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(await outcomesOf(ledger)).toHaveLength(1);
  });

  // The property retiring must not break: a row whose ledger outcome already exists (written by a
  // previous process, so this drainer never saw it send) is still skipped rather than re-sent.
  // Retire happens after that decision, never instead of it.
  it('still skips a row whose terminal outcome predates this drainer, then retires it', async () => {
    const { ledger, w } = await seedLedger();
    await ledger.append({ runId: RUN, at: NOW.toISOString(), event: 'action.outcome',
      principal: PRINCIPAL, payload: { requestId: REQ, warrantId: w.id, status: 'sent', messageId: 'earlier' } });
    const { sender, calls } = makeSender();
    const outbox = await makeOutbox();
    const r = await drainOutbox(makeDeps(ledger), { outbox, sender });
    expect(r.data).toEqual([{ requestId: REQ, status: 'skipped', code: 'already_terminal' }]);
    expect(calls).toEqual([]);
    expect((await outbox.listPending()).data).toEqual([]);
  });

  // The starvation case, measured on the first cut of this file: with no retire path and an
  // oldest-first LIMIT, accumulated terminal rows fill every slot and newer rows become
  // permanently unreachable. Deliberately more rows than DEFAULT_OUTBOX_LIMIT.
  it('reaches rows beyond the page limit once earlier rows retire', async () => {
    const outbox = new MemoryOutbox();
    const ledgers = new Map<string, MemoryLedger>();
    const total = DEFAULT_OUTBOX_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const id = `req-${String(i).padStart(4, '0')}`;
      const seeded = await seedLedger({ requestId: id, runId: id });
      ledgers.set(id, seeded.ledger);
      await outbox.enqueue({
        requestId: id, runId: id, params: PARAMS,
        enqueuedAt: new Date(NOW.getTime() + i * 1000).toISOString(),
      });
    }
    const { sender, calls } = makeSender();
    // A ledger router: each row's run lives in its own MemoryLedger, keyed by runId.
    const routed: Ledger = {
      append: (input) => ledgers.get(input.runId)!.append(input),
      readRun: (runId) => ledgers.get(runId)!.readRun(runId),
      readAll: async () => ({ data: [], error: null }),
    };
    const sent = new Set<string>();
    // Two passes are enough only because retiring frees the slots. Without it the second pass
    // returns the same first DEFAULT_OUTBOX_LIMIT rows and the last five never send.
    for (let pass = 0; pass < 2; pass++) {
      const r = await drainOutbox(makeDeps(routed), { outbox, sender });
      for (const x of r.data!) if (x.status === 'sent') sent.add(x.requestId);
    }
    expect(sent.size).toBe(total);
    expect(sent.has(`req-${String(total - 1).padStart(4, '0')}`)).toBe(true);
    expect(calls).toHaveLength(total);
    expect((await outbox.listPending()).data).toEqual([]);
  });
});

describe('drainOutbox: refusals that record an outcome', () => {
  it('refuses params tampered with after enqueue: params_mismatch, sender never called', async () => {
    const { ledger, w } = await seedLedger();
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender, { params: { ...PARAMS, to: 'attacker@example.com' } });
    expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code: 'params_mismatch' }]);
    expect(calls).toEqual([]);
    expect(await outcomesOf(ledger)).toEqual([
      { requestId: REQ, warrantId: w.id, status: 'failed', error: 'params_mismatch' },
    ]);
  });

  // Every case: the exact refusal code, the sender never called, and an action.outcome
  // recorded as failed so the spent nonce is never silently retried.
  const refusals: Array<[string, string, () => Promise<{ ledger: MemoryLedger; w: Warrant }>, unknown]> = [
    ['params canonicalJson rejects', 'params_noncanonical',
      () => seedLedger(), { ...PARAMS, count: 1n }],
    ['an expired warrant', 'warrant_warrant_expired',
      () => seedLedger({ warrant: mkWarrant({ issuedAt: new Date(NOW.getTime() - 7_200_000), ttlMs: 3_600_000 }) }), undefined],
    ['a warrant signed by a different keypair', 'warrant_invalid_signature',
      () => seedLedger({ warrant: mkWarrant({ keys: OTHER_KEYS }) }), undefined],
    ['a warrant minted for another run', 'warrant_run_mismatch',
      () => seedLedger({ warrant: mkWarrant({ runId: 'other-run' }) }), undefined],
    ['a row with no action.executed', 'not_executed',
      () => seedLedger({ executedWarrantId: null }), undefined],
    ['action.executed naming a different warrant', 'executed_warrant_mismatch',
      () => seedLedger({ executedWarrantId: 'some-other-warrant-id' }), undefined],
  ];
  it.each(refusals)('refuses %s: %s, sender never called', async (_name, code, seed, params) => {
    const { ledger, w } = await seed();
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender, params === undefined ? {} : { params });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code }]);
    expect(calls).toEqual([]);
    expect(await outcomesOf(ledger)).toEqual([
      { requestId: REQ, warrantId: w.id, status: 'failed', error: code },
    ]);
  });
});
