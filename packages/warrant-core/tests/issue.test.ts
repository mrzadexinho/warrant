import { describe, it, expect } from 'vitest';
import { issueWarrant, verifyWarrant } from '../src/issue.js';
import type { IssueDeps } from '../src/issue.js';
import { generateKeyPair } from '../src/keys.js';
import type { ActionRequest, Verdict } from '../src/types.js';

const keys = generateKeyPair('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const FIXED_NOW = new Date('2026-07-16T10:00:00Z');
// newId increments per call: guarantees warrant.id !== warrant.nonce across all tests
let idSeq = 0;
const deps: IssueDeps = {
  keys, now: () => FIXED_NOW,
  newId: () => `id-${++idSeq}`,
};

const request: ActionRequest = {
  id: 'req1', runId: 'run1',
  principal: { kind: 'agent', id: 'agent-01' },
  action: { kind: 'send_email', target: 'lead@example.com', params: { subject: 'Hi' } },
  context: { audience: 'cold', sentTodayByKind: {}, qaScore: 85 },
};
const autoV: Verdict = { path: 'auto', ruleId: 'draft-for-review',
  policyVersion: '0.1.0', policyHash: 'h'.repeat(64), reason: 'matched' };
const humanV: Verdict = { path: 'human', ruleId: 'cold-email-hiring-manager',
  policyVersion: '0.1.0', policyHash: 'h'.repeat(64), reason: 'review required' };
const denyV: Verdict = { path: 'deny', ruleId: 'default-deny',
  policyVersion: '0.1.0', policyHash: 'h'.repeat(64), reason: 'no match' };

describe('issueWarrant', () => {
  it('issues auto warrant with correct fields', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    expect(r.error).toBeNull();
    expect(r.data?.verdictPath).toBe('auto');
    expect(r.data?.id).toMatch(/^id-\d+$/);
    expect(r.data?.nonce).toMatch(/^id-\d+$/);
    expect(r.data?.signature).toMatch(/^[0-9a-f]{128}$/);
  });
  it('warrant.id !== warrant.nonce (two separate newId() calls)', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    // id and nonce come from successive newId() calls: they must be distinct
    expect(r.data?.id).not.toBe(r.data?.nonce);
  });
  it('issues human warrant carrying reviewRef', () => {
    const r = issueWarrant({ request, verdict: humanV, reviewRef: 'rv-99', ttlMs: 300_000 }, deps);
    expect(r.error).toBeNull();
    expect(r.data?.verdictPath).toBe('human');
    expect(r.data?.reviewRef).toBe('rv-99');
  });
  it('deny verdict → err cannot_issue_on_deny', () => {
    const r = issueWarrant({ request, verdict: denyV, ttlMs: 60_000 }, deps);
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('cannot_issue_on_deny');
    expect(r.error?.type).toBe('validation');
  });
  it('expiresAt = issuedAt + ttlMs', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const diff = new Date(r.data!.expiresAt).getTime() - new Date(r.data!.issuedAt).getTime();
    expect(diff).toBe(60_000);
  });
  it('non-canonical params (Date) → err noncanonical_params, does NOT throw', () => {
    const badRequest: ActionRequest = {
      ...request,
      action: { ...request.action, params: { d: new Date() } },
    };
    let threw = false;
    let result: ReturnType<typeof issueWarrant> | undefined;
    try {
      result = issueWarrant({ request: badRequest, verdict: autoV, ttlMs: 60_000 }, deps);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.data).toBeNull();
    expect(result?.error?.code).toBe('noncanonical_params');
    expect(result?.error?.type).toBe('validation');
  });
});

describe('verifyWarrant', () => {
  it('valid warrant at issuance time passes', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(r.data!, keys.publicKeyHex, FIXED_NOW);
    expect(v.data).toBe(true);
    expect(v.error).toBeNull();
  });
  it('expired warrant → warrant_expired', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(r.data!, keys.publicKeyHex, new Date(FIXED_NOW.getTime() + 120_000));
    expect(v.data).toBeNull();
    expect(v.error?.code).toBe('warrant_expired');
  });
  it('tampered field → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant({ ...r.data!, nonce: 'TAMPERED' }, keys.publicKeyHex, FIXED_NOW);
    expect(v.data).toBeNull();
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('reviewRef round-trips through sign+verify', () => {
    const r = issueWarrant({ request, verdict: humanV, reviewRef: 'rv-42', ttlMs: 60_000 }, deps);
    expect(r.data?.reviewRef).toBe('rv-42');
    expect(verifyWarrant(r.data!, keys.publicKeyHex, FIXED_NOW).data).toBe(true);
  });
  it('tampered paramsHash → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(
      { ...r.data!, action: { ...r.data!.action, paramsHash: 'a'.repeat(64) } },
      keys.publicKeyHex, FIXED_NOW,
    );
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('tampered expiresAt → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(
      { ...r.data!, expiresAt: new Date(FIXED_NOW.getTime() + 999_999).toISOString() },
      keys.publicKeyHex, FIXED_NOW,
    );
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('tampered action.target → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(
      { ...r.data!, action: { ...r.data!.action, target: 'evil@attacker.com' } },
      keys.publicKeyHex, FIXED_NOW,
    );
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('tampered principal → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const v = verifyWarrant(
      { ...r.data!, principal: { kind: 'human', id: 'attacker' } },
      keys.publicKeyHex, FIXED_NOW,
    );
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('cross-key verify → invalid_signature', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    const otherKeys = generateKeyPair('1'.repeat(64));
    const v = verifyWarrant(r.data!, otherKeys.publicKeyHex, FIXED_NOW);
    expect(v.error?.code).toBe('invalid_signature');
  });
  it('exactly-at-expiry boundary → warrant_expired', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    // at === expiresAt: expiresAt <= at → expired
    const atExpiry = new Date(r.data!.expiresAt);
    const v = verifyWarrant(r.data!, keys.publicKeyHex, atExpiry);
    expect(v.error?.code).toBe('warrant_expired');
  });
  it('no reviewRef auto warrant round-trips (reviewRef absent)', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    expect(r.data?.reviewRef).toBeUndefined();
    expect(verifyWarrant(r.data!, keys.publicKeyHex, FIXED_NOW).data).toBe(true);
  });
  it('junk non-plain-object field → returns Result, does NOT throw', () => {
    const r = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    // Inject a non-plain-object field that would make raw canonicalJson throw.
    // WarrantSchema is strictObject, so the unknown key is REFUSED as malformed_warrant
    // rather than stripped; either way the property under test is that verifyWarrant
    // returns a Result and never propagates a throw.
    const tampered = { ...r.data!, junk: new Date() } as unknown as import('../src/types.js').Warrant;
    let threw = false;
    let result: ReturnType<typeof verifyWarrant> | undefined;
    try {
      result = verifyWarrant(tampered, keys.publicKeyHex, FIXED_NOW);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Result is a valid Result<true, WarrantError>: never an uncaught throw.
    expect(result).toBeDefined();
    expect(result?.data === true || result?.error !== null).toBe(true);
  });
});

// Panel finding, pre-publication review: new Date('garbage') <= now is false, so an
// unparseable expiresAt made a warrant immortal if its signature checked out. The issuer
// cannot mint one (toISOString throws first), but verifyWarrant is public API and must not
// depend on every issuer being well-behaved.
describe('verifyWarrant refuses unparseable timestamps', () => {
  async function resignWith(over: Record<string, string>) {
    const { canonicalJson, signHex } = await import('../src/index.js');
    const issued = issueWarrant({ request, verdict: autoV, ttlMs: 60_000 }, deps);
    if (!issued.data) throw new Error('fixture issue failed');
    const { signature: _sig, ...unsigned } = issued.data;
    const tampered = { ...unsigned, ...over };
    const signature = signHex(canonicalJson(tampered), keys.privateKeyHex);
    return { ...tampered, signature };
  }

  it('a warrant whose expiresAt does not parse is malformed, not immortal', async () => {
    const w = await resignWith({ expiresAt: 'never' });
    const r = verifyWarrant(w as never, keys.publicKeyHex, FIXED_NOW);
    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('a warrant whose issuedAt does not parse is malformed', async () => {
    const w = await resignWith({ issuedAt: 'not-a-date' });
    const r = verifyWarrant(w as never, keys.publicKeyHex, FIXED_NOW);
    expect(r.error?.code).toBe('malformed_warrant');
  });
});
