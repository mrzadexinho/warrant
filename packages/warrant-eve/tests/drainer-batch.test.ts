// drainer-batch.test.ts: the governed drainer's skips, failure modes, batch behaviour and lock.
// The send path and the outcome-recording refusals live in drainer.test.ts; shared setup is
// drainer-fixtures.ts. Split because one file crossed the 400-line test limit.
import { describe, it, expect } from 'vitest';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger } from '@idriszade/warrant-ledger';
import { MemoryOutbox } from '../src/outbox.js';
import type { DrainerLock } from '../src/outbox.js';
import { drainOutbox } from '../src/drainer.js';
import {
  KEYS, OTHER_KEYS, NOW, RUN, REQ, PRINCIPAL, PARAMS,
  mkWarrant, seedLedger, makeSender, makeLock, makeDeps, makeOutbox, drain,
  entriesOf, outcomesOf, OutcomeFailingLedger, ReadFailingLedger,
} from './drainer-fixtures.js';

describe('drainOutbox: skips that write nothing', () => {
  it('skips a requestId with TWO warrant.issued entries and appends nothing', async () => {
    const { ledger } = await seedLedger({ issued: 2 });
    const before = (await entriesOf(ledger)).length;
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.data).toEqual([{ requestId: REQ, status: 'skipped', code: 'warrant_missing' }]);
    expect(calls).toEqual([]);
    expect((await entriesOf(ledger)).length).toBe(before);
  });

  it('skips a requestId with ZERO warrant.issued entries and appends nothing', async () => {
    const ledger = new MemoryLedger();
    await ledger.append({ runId: RUN, at: NOW.toISOString(), event: 'warrant.requested',
      principal: PRINCIPAL, payload: { requestId: REQ } });
    const before = (await entriesOf(ledger)).length;
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.data).toEqual([{ requestId: REQ, status: 'skipped', code: 'warrant_missing' }]);
    expect(calls).toEqual([]);
    expect((await entriesOf(ledger)).length).toBe(before);
  });

  it('skips when the run cannot be read: ledger_read_error, no send, no write', async () => {
    const { sender, calls } = makeSender();
    const r = await drain(new ReadFailingLedger('err'), sender);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'skipped', code: 'ledger_read_error' }]);
    expect(calls).toEqual([]);
  });

  it.each(['sent', 'failed'])(
    'skips a row already terminal with status %s: no second send, no second row', async (status) => {
      const { ledger } = await seedLedger({ outcomeStatuses: [status] });
      const { sender, calls } = makeSender();
      const r = await drain(ledger, sender);
      expect(r.data).toEqual([{ requestId: REQ, status: 'skipped', code: 'already_terminal' }]);
      expect(calls).toEqual([]);
      expect(await outcomesOf(ledger)).toHaveLength(1);
    });

  // queued is what `execute` writes, so EVERY legitimate row has one. Treating it as
  // terminal would make the drainer send nothing at all, ever.
  it('does NOT treat status queued as terminal: the row still sends', async () => {
    const { ledger } = await seedLedger({ outcomeStatuses: ['queued'] });
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.data).toEqual([{ requestId: REQ, status: 'sent', messageId: 'msg-1' }]);
    expect(calls).toHaveLength(1);
    expect((await outcomesOf(ledger)).map(p => p['status'])).toEqual(['queued', 'sent']);
  });
});

describe('drainOutbox: send and ledger failures', () => {
  it.each([['err', 'send_smtp_unreachable'], ['throw', 'send_threw']] as const)(
    'records action.outcome{failed} when the sender %ss, and still resolves ok', async (mode, code) => {
      const { ledger, w } = await seedLedger();
      const { sender, calls } = makeSender(mode);
      const r = await drain(ledger, sender);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code }]);
      expect(calls).toHaveLength(1);
      expect(await outcomesOf(ledger)).toEqual([
        { requestId: REQ, warrantId: w.id, status: 'failed', error: code },
      ]);
    });

  // The send DID happen; the drainer reports failed because the ledger, which is the only
  // authority on whether an action was sent, holds no record of it. outcome_append_error
  // names exactly that state so an operator can tell it from a send that never left.
  it.each(['err', 'throw'] as const)(
    'does not crash the drain when the outcome append %ss', async (mode) => {
      const { ledger } = await seedLedger();
      const { sender, calls } = makeSender();
      const r = await drain(new OutcomeFailingLedger(ledger, mode), sender);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code: 'outcome_append_error' }]);
      expect(calls).toHaveLength(1);
    });

  it('returns the outbox error unchanged when listPending fails, and never sends', async () => {
    const { ledger } = await seedLedger();
    const { sender, calls } = makeSender();
    const outbox = {
      async enqueue() { return ok(undefined); },
      async listPending() { return err({ type: 'transient' as const, code: 'db_error', message: 'down' }); },
      async retire() { return ok(undefined); },
    };
    const r = await drainOutbox(makeDeps(ledger), { outbox, sender });
    expect(r.data).toBeNull();
    expect(r.error!.code).toBe('db_error');
    expect(calls).toEqual([]);
  });

  it('reports a per-row failure instead of throwing when the ledger read throws', async () => {
    const { sender, calls } = makeSender();
    const r = await drain(new ReadFailingLedger('throw'), sender);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code: 'drainer_internal_error' }]);
    expect(calls).toEqual([]);
  });

  // The reason the catch moved inside the loop. A throw on a later row used to discard the results
  // of every earlier row, including rows that had REALLY SENT: the caller was handed
  // {data:null, error:drainer_internal_error} and could not tell that an email had left.
  it('keeps the sent result of an earlier row when a later row throws', async () => {
    const good = await seedLedger({ requestId: 'req-ok', runId: 'run-ok' });
    const { sender, calls } = makeSender();
    const outbox = new MemoryOutbox();
    await outbox.enqueue({ requestId: 'req-ok', runId: 'run-ok', params: PARAMS, enqueuedAt: NOW.toISOString() });
    await outbox.enqueue({ requestId: 'req-bad', runId: 'run-bad', params: PARAMS,
      enqueuedAt: new Date(NOW.getTime() + 1000).toISOString() });
    const routed: Ledger = {
      append: (input) => good.ledger.append(input),
      readRun: (runId) => {
        if (runId === 'run-bad') throw new Error('connection reset');
        return good.ledger.readRun(runId);
      },
      readAll: async () => ({ data: [], error: null }),
    };
    const r = await drainOutbox(makeDeps(routed), { outbox, sender });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([
      { requestId: 'req-ok', status: 'sent', messageId: 'msg-1' },
      { requestId: 'req-bad', status: 'failed', code: 'drainer_internal_error' },
    ]);
    expect(calls).toHaveLength(1);
    // The thrown row is NOT retired: nothing in the ledger records its fate, and a throw is
    // usually transient, so it must remain visible and retryable.
    expect((await outbox.listPending()).data!.map(x => x.requestId)).toEqual(['req-bad']);
  });

  it('still returns a batch-level typed err when listPending itself throws', async () => {
    const { ledger } = await seedLedger();
    const { sender, calls } = makeSender();
    const outbox = {
      async enqueue() { return ok(undefined); },
      async listPending(): Promise<Result<never, WarrantError>> { throw new Error('pool gone'); },
      async retire() { return ok(undefined); },
    };
    const r = await drainOutbox(makeDeps(ledger), { outbox, sender });
    expect(r.data).toBeNull();
    expect(r.error!.code).toBe('drainer_internal_error');
    expect(r.error!.type).toBe('transient');
    expect(calls).toEqual([]);
  });

  it('passes the caller limit through to the outbox', async () => {
    const { ledger } = await seedLedger();
    const { sender } = makeSender();
    const seen: (number | undefined)[] = [];
    const outbox = {
      async enqueue() { return ok(undefined); },
      async listPending(limit?: number) { seen.push(limit); return ok([]); },
      async retire() { return ok(undefined); },
    };
    await drainOutbox(makeDeps(ledger), { outbox, sender, limit: 7 });
    await drainOutbox(makeDeps(ledger), { outbox, sender });
    expect(seen).toEqual([7, undefined]);
  });

  // Step 2 says "exactly one warrant.issued"; step 6 read only the FIRST action.executed, so a run
  // holding two (one naming this warrant, one naming another) resolved on array order alone.
  it('refuses when ANY action.executed for the requestId names a different warrant', async () => {
    const { ledger, w } = await seedLedger();
    await ledger.append({ runId: RUN, at: NOW.toISOString(), event: 'action.executed',
      principal: PRINCIPAL, payload: { requestId: REQ, warrantId: 'w-someone-else', nonce: 'n2' } });
    const { sender, calls } = makeSender();
    const r = await drain(ledger, sender);
    expect(r.data).toEqual([{ requestId: REQ, status: 'failed', code: 'executed_warrant_mismatch' }]);
    expect(calls).toEqual([]);
    expect(w.id).not.toBe('w-someone-else');
  });
});

describe('drainOutbox: the drainer lock', () => {
  it('returns ok([]) and never sends or releases when the lock is unavailable', async () => {
    const { ledger } = await seedLedger();
    const { sender, calls } = makeSender();
    const { lock, calls: lockCalls } = makeLock(false);
    const r = await drain(ledger, sender, { lock });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([]);
    expect(calls).toEqual([]);
    expect(lockCalls).toEqual({ acquire: 1, release: 0 });
    expect(await outcomesOf(ledger)).toEqual([]);
  });

  it('releases the lock after a successful drain', async () => {
    const { ledger } = await seedLedger();
    const { sender } = makeSender();
    const { lock, calls: lockCalls } = makeLock(true);
    const r = await drain(ledger, sender, { lock });
    expect(r.data![0]!.status).toBe('sent');
    expect(lockCalls).toEqual({ acquire: 1, release: 1 });
  });

  // A throw out of finally replaces the return value, so an unguarded release() that rejects
  // would turn a completed send into a rejected drain.
  it('still resolves ok when the lock release throws', async () => {
    const { ledger } = await seedLedger();
    const { sender } = makeSender();
    const lock: DrainerLock = {
      async acquire() { return true; },
      async release() { throw new Error('release exploded'); },
    };
    const r = await drain(ledger, sender, { lock });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ requestId: REQ, status: 'sent', messageId: 'msg-1' }]);
  });

  it('returns drainer_lock_error and never sends when acquire throws', async () => {
    const { ledger } = await seedLedger();
    const { sender, calls } = makeSender();
    const { lock, calls: lockCalls } = makeLock('throw');
    const r = await drain(ledger, sender, { lock });
    expect(r.data).toBeNull();
    expect(r.error!.code).toBe('drainer_lock_error');
    expect(calls).toEqual([]);
    expect(lockCalls.release).toBe(0);
  });
});
