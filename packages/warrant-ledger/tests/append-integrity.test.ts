// Ledger guards a mutation sweep found unheld across every package that consumes this
// one, not just here.
//
// The ledger is the evidence. Everything downstream (the certificate, the replay, the
// DSSE payload) is a rendering of what it holds, so a guard that stops existing here
// does not produce a wrong answer, it produces a wrong record that every later layer
// then faithfully reports.
//
// Each test was checked by re-deleting its guard and confirming this test then fails,
// with the deletion diffed to prove it applied.
import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '../src/memory.js';
import { GENESIS_PREV_HASH, entryHash, reviewIdOf, reviewRefOf } from '../src/entry.js';
import type { LedgerAppendInput, LedgerEntry } from '../src/entry.js';

const inp = (o: Partial<LedgerAppendInput> = {}): LedgerAppendInput => ({
  runId: 'run-1', at: '2026-07-27T00:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'a' }, payload: { step: 1 }, ...o,
});

async function twoEntryLedger(): Promise<{ ledger: MemoryLedger; entries: LedgerEntry[] }> {
  const l = new MemoryLedger();
  expect((await l.append(inp())).error).toBeNull();
  expect((await l.append(inp({ at: '2026-07-27T00:00:01.000Z', payload: { step: 2 } }))).error).toBeNull();
  return { ledger: l, entries: (await l.readAll()).data! };
}

describe('fromEntries checks the linkage, not only the seq numbers and the hashes', () => {
  it('rejects a chain whose first entry does not link to GENESIS', async () => {
    // The seq-contiguity check and the per-entry hash recompute were both covered; the
    // prevHash linkage was not, and it is the one that anchors the chain to a fixed
    // starting point. Without it a chain that begins partway through another chain
    // loads as complete, and every later reader treats a truncated history as the
    // whole history.
    const { entries } = await twoEntryLedger();
    const head = { ...entries[0]!, prevHash: 'ab'.repeat(32) };
    // Recompute forward so the ONLY thing wrong is where the chain starts.
    head.hash = entryHash({
      seq: head.seq, prevHash: head.prevHash, runId: head.runId,
      at: head.at, event: head.event, principal: head.principal, payload: head.payload,
    });
    const next = { ...entries[1]!, prevHash: head.hash };
    next.hash = entryHash({
      seq: next.seq, prevHash: next.prevHash, runId: next.runId,
      at: next.at, event: next.event, principal: next.principal, payload: next.payload,
    });

    expect(() => MemoryLedger.fromEntries([head, next])).toThrow(/prevHash mismatch/);
  });

  it('rejects a chain whose middle link points at the wrong predecessor', async () => {
    const { entries } = await twoEntryLedger();
    const second = { ...entries[1]!, prevHash: GENESIS_PREV_HASH };
    second.hash = entryHash({
      seq: second.seq, prevHash: second.prevHash, runId: second.runId,
      at: second.at, event: second.event, principal: second.principal, payload: second.payload,
    });

    expect(() => MemoryLedger.fromEntries([entries[0]!, second])).toThrow(/prevHash mismatch/);
  });

  it('accepts the genuine chain, so the linkage check is not rejecting everything', async () => {
    const { entries } = await twoEntryLedger();
    const restored = MemoryLedger.fromEntries(entries);
    expect((await restored.readAll()).data).toEqual(entries);
  });
});

describe('the ledger hands out copies and keeps none of the caller`s objects', () => {
  it('mutating the entry returned by append does not change the chain', async () => {
    // readAll and readRun were already covered; the entry append RETURNS was not, and it
    // is the one every caller has a reference to. warrant-eve reads `.data` off an
    // append on the mint path, so a caller that annotated the object it got back would
    // be editing the ledger's own row.
    const l = new MemoryLedger();
    const returned = (await l.append(inp())).data!;
    const originalHash = returned.hash;

    (returned as unknown as Record<string, unknown>)['hash'] = 'deadbeef'.repeat(8);
    (returned as unknown as Record<string, unknown>)['payload'] = { FORGED: true };

    const stored = (await l.readAll()).data![0]!;
    expect(stored.hash).toBe(originalHash);
    expect(stored.payload).toEqual({ step: 1 });
  });

  it('mutating the entries handed to fromEntries afterwards does not change the chain', async () => {
    // fromEntries validates the array it is given and then keeps it. Without the
    // structuredClone it keeps the CALLER's objects, so a caller that reuses or edits
    // that array after loading is editing a ledger that already verified.
    const { entries } = await twoEntryLedger();
    const restored = MemoryLedger.fromEntries(entries);

    (entries[0]! as unknown as Record<string, unknown>)['payload'] = { FORGED: true };

    const stored = (await restored.readAll()).data![0]!;
    expect(stored.payload).toEqual({ step: 1 });
    expect(stored.payload).not.toEqual({ FORGED: true });
  });
});

describe('the nonce spend-once record is scoped to the event that spends it', () => {
  it('a nonce appearing on a different event does not block the execution', async () => {
    // Only a positive case can see this scope. Every negative nonce test passes whether
    // or not the check is restricted to action.executed, because a genuine double-spend
    // is two action.executed entries either way. Drop the scope and any earlier entry
    // that happens to carry a top-level `nonce` burns it: warrant.voided is the obvious
    // candidate, and an event added later that echoes the warrant's nonce would silently
    // make every subsequent execution impossible.
    const l = new MemoryLedger();
    expect((await l.append(inp({ event: 'warrant.voided', payload: { warrantId: 'w-1', nonce: 'n-1' } }))).error)
      .toBeNull();

    const executed = await l.append(inp({
      at: '2026-07-27T00:00:01.000Z', event: 'action.executed',
      payload: { warrantId: 'w-1', nonce: 'n-1' },
    }));

    expect(executed.error).toBeNull();
    expect(executed.data!.seq).toBe(2);
  });

  it('a genuine double-spend is still refused', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ event: 'action.executed', payload: { warrantId: 'w-1', nonce: 'n-1' } }));
    const second = await l.append(inp({
      at: '2026-07-27T00:00:01.000Z', event: 'action.executed',
      payload: { warrantId: 'w-1', nonce: 'n-1' },
    }));

    expect(second.error?.code).toBe('nonce_spent');
  });
});

describe('claim keys are read only from object payloads', () => {
  it.each([
    ['a string payload', 'reviewId'],
    ['a number payload', 42],
    ['an array payload', ['reviewId']],
    // The case the sweep's mutation distinguishes: typeof a function is 'function', not
    // 'object', so the typeof test rejects it while an Object() coercion would read its
    // properties and derive a claim key from something the ledger can never even store.
    ['a function payload carrying a reviewId property', Object.assign(() => undefined, { reviewId: 'smuggled', reviewRef: 'smuggled' })],
  ])('%s yields no claim key', (_label, payload) => {
    expect(reviewIdOf(payload)).toBeUndefined();
    expect(reviewRefOf(payload)).toBeUndefined();
  });

  it('an ordinary object payload still yields its claim keys', () => {
    expect(reviewIdOf({ reviewId: 'rv-1' })).toBe('rv-1');
    expect(reviewRefOf({ reviewRef: 'rv-1' })).toBe('rv-1');
    // Non-string values are not claim keys either, which the existing suite covers, but
    // it belongs next to the positive case so the pair reads as one rule.
    expect(reviewIdOf({ reviewId: 42 })).toBeUndefined();
  });
});
