// Post-hoc characterization tests (fast-check ^4.4.0). Expected PASS; failure means impl bug.
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { entryHash, GENESIS_PREV_HASH } from '../src/entry.js';
import { MemoryLedger } from '../src/memory.js';
import type { LedgerAppendInput } from '../src/entry.js';

const baseInput = (o: Partial<LedgerAppendInput> = {}): LedgerAppendInput => ({
  runId: 'prop-run', at: '2026-07-16T00:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'prop-agent' }, payload: {}, ...o,
});

describe('entryHash: determinism (property)', () => {
  it('same inputs always produce same hash', () => {
    fc.assert(fc.property(
      fc.jsonValue(),
      (payload) => {
        const e = { seq: 1, prevHash: GENESIS_PREV_HASH, ...baseInput({ payload }) };
        return entryHash(e) === entryHash(e);
      },
    ), { seed: 42 });
  });

  it('payload key order does not affect hash (canonicalization)', () => {
    fc.assert(fc.property(
      fc.record({ a: fc.string(), b: fc.integer(), c: fc.boolean() }),
      (payload) => {
        const reversed: Record<string, unknown> = {};
        for (const k of Object.keys(payload).reverse()) reversed[k] = (payload as Record<string, unknown>)[k];
        const e1 = { seq: 1, prevHash: GENESIS_PREV_HASH, ...baseInput({ payload }) };
        const e2 = { seq: 1, prevHash: GENESIS_PREV_HASH, ...baseInput({ payload: reversed }) };
        return entryHash(e1) === entryHash(e2);
      },
    ), { seed: 42 });
  });
});

describe('nonce single-use: MemoryLedger (property)', () => {
  it('duplicate nonce always errors nonce_spent', async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ minLength: 1 }),
      async (nonce) => {
        const ledger = new MemoryLedger();
        const r1 = await ledger.append(baseInput({ event: 'action.executed', payload: { warrantId: 'w1', nonce } }));
        expect(r1.error).toBeNull();
        const r2 = await ledger.append(baseInput({ event: 'action.executed', at: '2026-07-16T00:01:00.000Z', payload: { warrantId: 'w2', nonce } }));
        return r2.error?.code === 'nonce_spent';
      },
    ), { seed: 42 });
  });

  it('distinct nonces never produce nonce_spent', async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 5 }),
      async (nonces) => {
        const ledger = new MemoryLedger();
        for (let i = 0; i < nonces.length; i++) {
          const r = await ledger.append(baseInput({
            event: 'action.executed',
            at: `2026-07-16T00:0${i}:00.000Z`,
            payload: { warrantId: `w${i}`, nonce: nonces[i] },
          }));
          if (r.error !== null) return false;
        }
        return true;
      },
    ), { seed: 42 });
  });
});
