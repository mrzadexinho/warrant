// Security fixes regression tests (review findings 1–3).
import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '../src/memory.js';
import type { LedgerAppendInput, LedgerEntry } from '../src/entry.js';

const inp = (o: Partial<LedgerAppendInput> = {}): LedgerAppendInput => ({
  runId: 'sec-run', at: '2026-07-16T00:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'sec-agent' }, payload: {}, ...o,
});

// Fix #1: seq contiguity in fromEntries
describe('fromEntries: seq contiguity (fix #1)', () => {
  it('rejects chain with gap [seq1, seq3] even when hashes are self-consistent', async () => {
    // Build a legitimate 3-entry chain, then delete entry 2 and re-link entry 3 to entry 1.
    const l = new MemoryLedger();
    const e1 = (await l.append(inp())).data!;
    const e2 = (await l.append(inp({ at: '2026-07-16T00:00:01.000Z' }))).data!;
    const e3 = (await l.append(inp({ at: '2026-07-16T00:00:02.000Z' }))).data!;
    // Suppress unused-variable warning: e2 is intentionally omitted to simulate deletion forgery
    void e2;

    // Attacker re-links e3 to e1's hash and recomputes e3's hash.
    // The resulting [e1, forgedE3] chain has valid prevHash linkage and valid hashes
    // but has a seq gap (1 → 3).
    const { sha256Hex, canonicalJson } = await import('@idriszade/warrant-core');
    const forgedE3: LedgerEntry = { ...e3, seq: 3, prevHash: e1.hash };
    const body = canonicalJson({ runId: forgedE3.runId, at: forgedE3.at, event: forgedE3.event, principal: forgedE3.principal, payload: forgedE3.payload });
    forgedE3.hash = sha256Hex(`${forgedE3.seq}\n${forgedE3.prevHash}\n${body}`);

    expect(() => MemoryLedger.fromEntries([e1, forgedE3])).toThrow(/Chain broken/);
  });
});

// Fix #2: throw-safe append; non-plain payloads must not throw
describe('append: throw-safe on noncanonical payload (fix #2)', () => {
  it('returns err noncanonical_payload for Date in payload, does not throw', async () => {
    const l = new MemoryLedger();
    const before = (await l.readAll()).data!.length;
    const r = await l.append(inp({ payload: { d: new Date() } }));
    expect(r.error).not.toBeNull();
    expect(r.error!.type).toBe('integrity');
    expect(r.error!.code).toBe('noncanonical_payload');
    // Entry count must be unchanged: no partial append
    const after = (await l.readAll()).data!.length;
    expect(after).toBe(before);
  });

  it('returns err noncanonical_payload for Map in payload, does not throw', async () => {
    const l = new MemoryLedger();
    const r = await l.append(inp({ payload: { m: new Map() } }));
    expect(r.error!.code).toBe('noncanonical_payload');
  });
});

// Fix #3: read encapsulation; mutating returned entries must not corrupt the ledger
describe('readAll/readRun: deep-copy isolation (fix #3)', () => {
  it('mutating readAll result does not affect subsequent readAll', async () => {
    const l = new MemoryLedger();
    await l.append(inp());
    const first = (await l.readAll()).data!;
    // Mutate the returned entry
    const firstEntry = first[0];
    expect(firstEntry).toBeDefined();
    (firstEntry as unknown as Record<string, unknown>)['hash'] = 'deadbeef'.repeat(8);
    (firstEntry as unknown as Record<string, unknown>)['payload'] = { FORGED: true };
    const second = (await l.readAll()).data!;
    expect(second[0]!.hash).toHaveLength(64);
    expect(second[0]!.hash).not.toBe('deadbeef'.repeat(8));
    expect(second[0]!.payload).not.toEqual({ FORGED: true });
  });

  it('mutating readRun result does not affect subsequent readRun', async () => {
    const l = new MemoryLedger();
    await l.append(inp({ runId: 'iso-run' }));
    const first = (await l.readRun('iso-run')).data!;
    const firstEntry = first[0];
    expect(firstEntry).toBeDefined();
    (firstEntry as unknown as Record<string, unknown>)['payload'] = { FORGED: true };
    const second = (await l.readRun('iso-run')).data!;
    expect(second[0]!.payload).not.toEqual({ FORGED: true });
  });
});
