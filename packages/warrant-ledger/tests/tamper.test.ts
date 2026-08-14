import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '../src/memory.js';
import { entryHash } from '../src/entry.js';

describe('Tamper detection', () => {
  it('recomputed hash does not match stored hash after payload mutation', async () => {
    const ledger = new MemoryLedger();
    const r = await ledger.append({
      runId: 'tamper-run', at: '2026-07-16T00:00:00.000Z', event: 'warrant.issued',
      principal: { kind: 'agent', id: 'tamper-agent' }, payload: { warrantId: 'w-original' },
    });
    const entry = r.data!;
    const storedHash = entry.hash;
    // Simulate storage-level mutation
    const mutated = { ...entry, payload: { warrantId: 'w-FORGED' } };
    const { hash: _ignored, ...restMutated } = mutated;
    expect(entryHash(restMutated)).not.toBe(storedHash);
  });
});
