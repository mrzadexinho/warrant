import { describe, it, expect } from 'vitest';
import { sha256Hex, paramsHash } from '../src/hash.js';

describe('sha256Hex', () => {
  it('known test vector: sha256("") = e3b0...', () => {
    // NIST FIPS 180-4 test vector
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('known test vector: sha256("abc")', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('returns 64 lowercase hex chars', () => {
    expect(sha256Hex('warrant-test')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('paramsHash', () => {
  it('is deterministic regardless of key insertion order', () => {
    expect(paramsHash({ b: 2, a: 1 })).toBe(paramsHash({ a: 1, b: 2 }));
  });
  it('returns 64 hex chars', () => {
    expect(paramsHash({ subject: 'Hi', body: 'Hello' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
