// portfolio/packages/warrant-policy/tests/match.test.ts
import { describe, it, expect } from 'vitest';
import { globToRegExp } from '../src/match.js';

describe('globToRegExp', () => {
  it('literal match', () => {
    expect(globToRegExp('press@example.com').test('press@example.com')).toBe(true);
    expect(globToRegExp('press@example.com').test('other@example.com')).toBe(false);
  });

  it('* wildcard matches any segment', () => {
    expect(globToRegExp('*@*.gov').test('ceo@agency.gov')).toBe(true);
    expect(globToRegExp('*@*.gov').test('ceo@agency.com')).toBe(false);
    expect(globToRegExp('press@*').test('press@nytimes.com')).toBe(true);
    expect(globToRegExp('press@*').test('editor@nytimes.com')).toBe(false);
  });

  it('full-string anchor: no partial match', () => {
    expect(globToRegExp('*@*.gov').test('x@y.gov.evil.com')).toBe(false);
    expect(globToRegExp('press@*').test('notpress@example.com')).toBe(false);
  });

  it('regex special chars in literal are escaped', () => {
    expect(globToRegExp('a.b@c.d').test('aXb@cYd')).toBe(false);
    expect(globToRegExp('a.b@c.d').test('a.b@c.d')).toBe(true);
  });
});
