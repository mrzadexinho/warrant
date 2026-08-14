/**
 * The security core, tested on its own rather than through any one of its three call sites.
 *
 * Every refusal branch gets a test, because "fail-closed is a test, not a comment" and this is
 * the function the whole enforcement seam narrows to. The params here are a ticket, not
 * anything an actuator would recognise: if this primitive needs to know what it is guarding,
 * it is not a guard.
 */

import { describe, expect, it } from 'vitest';
import type { Warrant } from '@idriszade/warrant-core';
import { generateKeyPair, issueWarrant, paramsHash } from '@idriszade/warrant-core';
import { verifyAuthorizedParams } from '../src/index.js';
import type { AuthorityCheckDeps } from '../src/index.js';

const { publicKeyHex, privateKeyHex } = generateKeyPair('a'.repeat(64));
const OTHER = generateKeyPair('b'.repeat(64));
const ISSUE_AT = new Date('2026-01-01T00:00:00Z');
const ACT_AT = new Date('2026-01-01T00:00:30Z');

const VALID = { ticketId: 'INC-42', severity: 3 };

function makeWarrant(
  opts: {
    params?: unknown;
    ttlMs?: number;
    runId?: string;
    keys?: { publicKeyHex: string; privateKeyHex: string };
  } = {},
): Warrant {
  const keys = opts.keys ?? { publicKeyHex, privateKeyHex };
  const r = issueWarrant(
    {
      request: {
        id: 'req-1',
        runId: opts.runId ?? 'run-1',
        principal: { kind: 'agent' as const, id: 'agent-1' },
        action: { kind: 'open_ticket', target: 'svc-a', params: opts.params ?? VALID },
        context: { entityId: 'e-1' },
      },
      verdict: {
        path: 'auto' as const,
        ruleId: 'auto-ticket',
        policyVersion: '0.1.0',
        policyHash: 'b'.repeat(64),
        reason: 'ok',
      },
      ttlMs: opts.ttlMs ?? 60_000,
    },
    { keys, now: () => ISSUE_AT, newId: () => 'nonce-1' },
  );
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

const deps = (expectedRunId: string | null = null): AuthorityCheckDeps => ({
  publicKeyHex,
  now: () => ACT_AT,
  expectedRunId,
});

describe('verifyAuthorizedParams passes only when the warrant binds exactly these bytes', () => {
  it('accepts a valid warrant over the same params', () => {
    const r = verifyAuthorizedParams(makeWarrant(), VALID, deps());
    expect(r.error).toBeNull();
  });

  it('accepts params that are key-order-different but canonically identical', () => {
    // canonicalJson is what makes the digest an identity, so a re-serialised object with the
    // same content must still authorize. Otherwise every caller would owe the guard a
    // byte-stable transport, which is exactly the coupling this primitive refuses.
    const reordered = { severity: VALID.severity, ticketId: VALID.ticketId };
    const r = verifyAuthorizedParams(makeWarrant(), reordered, deps());
    expect(r.error).toBeNull();
  });
});

describe('verifyAuthorizedParams refuses before anything downstream', () => {
  it('returns the verify error unchanged for a tampered signature', () => {
    // Unchanged, not re-wrapped: callers map verify codes onto their own vocabulary and a
    // rewritten code here would silently change what three call sites report.
    const tampered = { ...makeWarrant(), signature: 'f'.repeat(128) };
    const r = verifyAuthorizedParams(tampered, VALID, deps());
    expect(r.error).toEqual({
      type: 'integrity',
      code: 'invalid_signature',
      message: 'Signature mismatch',
    });
  });

  it('returns the verify error for a warrant signed by another keypair', () => {
    const foreign = makeWarrant({ keys: OTHER });
    const r = verifyAuthorizedParams(foreign, VALID, deps());
    expect(r.error?.code).toBe('invalid_signature');
  });

  it('returns the verify error for an expired warrant', () => {
    const r = verifyAuthorizedParams(makeWarrant({ ttlMs: 1 }), VALID, deps());
    expect(r.error?.code).toBe('warrant_expired');
  });

  it('returns the verify error for a malformed warrant', () => {
    const r = verifyAuthorizedParams({ nope: true } as unknown as Warrant, VALID, deps());
    expect(r.error?.code).toBe('malformed_warrant');
  });

  it('refuses a params digest that does not match: GhostApproval', () => {
    const swapped = { ticketId: 'INC-999', severity: 1 };
    const r = verifyAuthorizedParams(makeWarrant(), swapped, deps());
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.code).toBe('params_mismatch');
  });

  it('refuses an extra key rather than ignoring it: no stripping happens here', () => {
    // The primitive takes FINAL params. Whatever the caller wanted removed must already be
    // gone; anything still present is part of the bytes and must be part of the digest.
    const injected = { ...VALID, injected: 'not-authorized' };
    const r = verifyAuthorizedParams(makeWarrant(), injected, deps());
    expect(r.error?.code).toBe('params_mismatch');
  });

  it('refuses params canonicalJson rejects, as a typed error rather than a throw', () => {
    // canonicalJson throws on non-plain values by design and params are caller data. A throw
    // escaping into a caller that is about to decide whether an action happened is the bug.
    const hostile = { ...VALID, count: 1n };
    const r = verifyAuthorizedParams(makeWarrant(), hostile, deps());
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.code).toBe('params_noncanonical');
  });

  it('checks the signature before the digest', () => {
    // Order is the invariant: an unverified warrant's paramsHash is attacker-controlled, so
    // comparing against it first would be comparing against nothing. Both are wrong here, and
    // the signature is the one that must be reported.
    const tampered = { ...makeWarrant(), signature: 'f'.repeat(128) };
    const r = verifyAuthorizedParams(tampered, { ticketId: 'other', severity: 1 }, deps());
    expect(r.error?.code).toBe('invalid_signature');
  });
});

describe('verifyAuthorizedParams treats expectedRunId as a written decision, not a default', () => {
  const OTHER_RUN = 'run-elsewhere';

  it('passes a warrant from another run when expectedRunId is null', () => {
    // Null means "this caller has no independent run to compare", which is true of a caller
    // that derives its own run FROM the warrant. It is not a weaker check by accident.
    const foreignRun = makeWarrant({ runId: OTHER_RUN });
    const r = verifyAuthorizedParams(foreignRun, VALID, deps(null));
    expect(r.error).toBeNull();
  });

  it('refuses that same warrant when expectedRunId is set', () => {
    // The identical input, one dep apart. runId is a signed field, so a store that returns
    // another run's rows cannot smuggle authority across runs once anyone is checking.
    const foreignRun = makeWarrant({ runId: OTHER_RUN });
    const r = verifyAuthorizedParams(foreignRun, VALID, deps('run-1'));
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.code).toBe('run_mismatch');
    expect(r.error?.message).toContain(OTHER_RUN);
  });

  it('passes when expectedRunId matches the warrant', () => {
    const r = verifyAuthorizedParams(makeWarrant(), VALID, deps('run-1'));
    expect(r.error).toBeNull();
  });

  it('checks the signature before the run', () => {
    const tampered = { ...makeWarrant({ runId: OTHER_RUN }), signature: 'f'.repeat(128) };
    const r = verifyAuthorizedParams(tampered, VALID, deps('run-1'));
    expect(r.error?.code).toBe('invalid_signature');
  });

  it('checks the run before the digest', () => {
    // Both wrong: the run mismatch is the one reported, because a warrant that belongs to
    // another run says nothing about these params either way.
    const foreignRun = makeWarrant({ runId: OTHER_RUN });
    const r = verifyAuthorizedParams(foreignRun, { ticketId: 'other', severity: 1 }, deps('run-1'));
    expect(r.error?.code).toBe('run_mismatch');
  });

  it('checks the run before a digest that would throw', () => {
    const foreignRun = makeWarrant({ runId: OTHER_RUN });
    const r = verifyAuthorizedParams(foreignRun, { ...VALID, count: 1n }, deps('run-1'));
    expect(r.error?.code).toBe('run_mismatch');
  });
});

describe('verifyAuthorizedParams is the same compare the warrant was minted with', () => {
  it('agrees with paramsHash over the authorized value', () => {
    // Pins the primitive to the one digest function rather than to a recomputation of its own.
    // A second implementation of the function that defines identity is the failure mode.
    const w = makeWarrant();
    expect(w.action.paramsHash).toBe(paramsHash(VALID));
    expect(verifyAuthorizedParams(w, VALID, deps()).error).toBeNull();
  });
});
