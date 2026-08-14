import { describe, it, expect } from 'vitest';
import { PrincipalSchema, ActionRequestSchema, VerdictSchema, WarrantSchema } from '../src/types.js';

describe('PrincipalSchema', () => {
  it('parses valid principal', () => {
    expect(PrincipalSchema.parse({ kind: 'agent', id: 'a1' }))
      .toEqual({ kind: 'agent', id: 'a1' });
  });
  it('rejects unknown kind', () => {
    expect(() => PrincipalSchema.parse({ kind: 'robot', id: 'x' })).toThrow();
  });
  it('rejects empty id', () => {
    expect(() => PrincipalSchema.parse({ kind: 'human', id: '' })).toThrow();
  });
});

describe('ActionRequestSchema', () => {
  const valid = {
    id: 'req1', runId: 'run1', principal: { kind: 'agent', id: 'a1' },
    action: { kind: 'send_email', target: 'u@x.com', params: { subject: 'Hi' } },
    context: { audience: 'cold', sentTodayByKind: {}, qaScore: 80 },
  };
  it('parses valid request', () => { expect(ActionRequestSchema.parse(valid)).toBeDefined(); });
  it('rejects missing runId', () => {
    const { runId: _r, ...rest } = valid;
    expect(() => ActionRequestSchema.parse(rest)).toThrow();
  });
});

describe('VerdictSchema', () => {
  const base = { ruleId: 'r', policyVersion: '0.1.0', policyHash: 'h', reason: 'ok' };
  it('parses auto', () => { expect(VerdictSchema.parse({ ...base, path: 'auto' }).path).toBe('auto'); });
  it('parses deny', () => { expect(VerdictSchema.parse({ ...base, path: 'deny' }).path).toBe('deny'); });
  it('rejects invalid path', () => { expect(() => VerdictSchema.parse({ ...base, path: 'maybe' })).toThrow(); });
});

describe('WarrantSchema', () => {
  const base = {
    id: 'w1', runId: 'run1', principal: { kind: 'agent', id: 'a1' },
    action: { kind: 'send_email', target: 't@x.com', paramsHash: 'a'.repeat(64) },
    policyVersion: '0.1.0', policyHash: 'h'.repeat(64),
    verdictPath: 'auto', issuedAt: '2026-07-16T00:00:00Z',
    expiresAt: '2026-07-16T01:00:00Z', nonce: 'n1', signature: 'sig',
  };
  it('parses valid warrant', () => { expect(WarrantSchema.parse(base)).toBeDefined(); });
  it('rejects paramsHash != 64 chars', () => {
    expect(() => WarrantSchema.parse({ ...base, action: { ...base.action, paramsHash: 'short' } })).toThrow();
  });
  it('reviewRef optional: absent and present both valid', () => {
    expect(WarrantSchema.parse(base).reviewRef).toBeUndefined();
    expect(WarrantSchema.parse({ ...base, reviewRef: 'rv1' }).reviewRef).toBe('rv1');
  });
});
