import { describe, it, expect } from 'vitest';
import { GENESIS_PREV_HASH, entryHash, MemoryLedger, PostgresLedger } from '../src/index.js';

describe('index re-exports', () => {
  it('GENESIS_PREV_HASH exported', () => { expect(GENESIS_PREV_HASH).toHaveLength(64); });
  it('entryHash exported', () => { expect(typeof entryHash).toBe('function'); });
  it('MemoryLedger exported', () => { expect(typeof MemoryLedger).toBe('function'); });
  it('PostgresLedger exported', () => { expect(typeof PostgresLedger).toBe('function'); });
});
