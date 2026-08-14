import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../src/canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('drops undefined-valued keys', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it('handles nested objects recursively', () => {
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: 0 }))
      .toBe('{"a":0,"z":{"a":1,"b":2}}');
  });
  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
  it('handles primitives', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });
  it('handles arrays of objects (sorts keys within each element)', () => {
    expect(canonicalJson([{ b: 2, a: 1 }])).toBe('[{"a":1,"b":2}]');
  });
});

describe('canonicalJson: adversarial (must throw [canonical])', () => {
  it('rejects undefined top-level', () => {
    expect(() => canonicalJson(undefined)).toThrow(/\[canonical\]/);
  });
  it('rejects undefined element in array', () => {
    expect(() => canonicalJson([1, undefined, 2])).toThrow(/\[canonical\]/);
  });
  it('rejects NaN', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/\[canonical\]/);
  });
  it('rejects Infinity', () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(/\[canonical\]/);
  });
  it('rejects -Infinity', () => {
    expect(() => canonicalJson({ a: -Infinity })).toThrow(/\[canonical\]/);
  });
  it('rejects Date', () => {
    expect(() => canonicalJson(new Date(0))).toThrow(/\[canonical\]/);
  });
  it('rejects Map', () => {
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(/\[canonical\]/);
  });
  it('rejects Set', () => {
    expect(() => canonicalJson(new Set([1]))).toThrow(/\[canonical\]/);
  });
  it('rejects BigInt', () => {
    expect(() => canonicalJson(10n)).toThrow(/\[canonical\]/);
  });
  it('rejects circular object', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalJson(a)).toThrow(/\[canonical\]/);
  });
});

describe('canonicalJson: collision-proof positives', () => {
  it('{a:1,b:undefined} === {a:1} (documented safe drop)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
  it('structurally-distinct plain payloads do not collide', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ b: 1 }));
    expect(canonicalJson([1])).not.toBe(canonicalJson({ '0': 1 }));
    expect(canonicalJson(null)).not.toBe(canonicalJson({}));
  });
});
