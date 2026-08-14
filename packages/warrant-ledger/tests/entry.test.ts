import { describe, it, expect } from 'vitest';
import { GENESIS_PREV_HASH, entryHash, reviewIdOf, reviewRefOf } from '../src/entry.js';
import type { LedgerEntry } from '../src/entry.js';
const BASE: Omit<LedgerEntry, 'hash'> = {
  seq: 1, runId: 'r', at: '2026-07-16T00:00:00.000Z', event: 'warrant.requested',
  principal: { kind: 'agent', id: 'a1' }, payload: { foo: 'bar' }, prevHash: GENESIS_PREV_HASH,
};

describe('GENESIS_PREV_HASH', () => {
  it('is 64 zeros', () => { expect(GENESIS_PREV_HASH).toMatch(/^0{64}$/); });
});

describe('entryHash', () => {
  it('returns 64-char hex', () => { expect(entryHash(BASE)).toMatch(/^[0-9a-f]{64}$/); });
  it('is deterministic', () => { expect(entryHash(BASE)).toBe(entryHash(BASE)); });
  it('changes on seq change', () => { expect(entryHash(BASE)).not.toBe(entryHash({ ...BASE, seq: 2 })); });
  it('changes on prevHash change', () => {
    expect(entryHash(BASE)).not.toBe(entryHash({ ...BASE, prevHash: 'a'.repeat(64) }));
  });
  it('canonical JSON: payload key order irrelevant', () => {
    expect(entryHash({ ...BASE, payload: { a: 1, b: 2 } }))
      .toBe(entryHash({ ...BASE, payload: { b: 2, a: 1 } }));
  });
});

describe('reviewIdOf', () => {
  it('returns the string reviewId when present', () => {
    expect(reviewIdOf({ reviewId: 'rev-1' })).toBe('rev-1');
  });
  it('returns undefined when absent, non-string, or payload is not a plain object', () => {
    expect(reviewIdOf({})).toBeUndefined();
    expect(reviewIdOf({ reviewId: 42 })).toBeUndefined();
    expect(reviewIdOf(null)).toBeUndefined();
    expect(reviewIdOf('not-an-object')).toBeUndefined();
  });
});

describe('reviewRefOf', () => {
  it('returns the string reviewRef when present', () => {
    expect(reviewRefOf({ reviewRef: 'rev-1' })).toBe('rev-1');
  });
  it('returns undefined when absent, non-string, or payload is not a plain object', () => {
    expect(reviewRefOf({})).toBeUndefined();
    expect(reviewRefOf({ reviewRef: 42 })).toBeUndefined();
    expect(reviewRefOf(null)).toBeUndefined();
    expect(reviewRefOf('not-an-object')).toBeUndefined();
  });
  it('reviewId and reviewRef are independent: a reviewId payload has no reviewRef', () => {
    expect(reviewRefOf({ reviewId: 'rev-1' })).toBeUndefined();
    expect(reviewIdOf({ reviewRef: 'rev-1' })).toBeUndefined();
  });
});
