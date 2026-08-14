import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, access, chmod } from 'node:fs/promises';
import type { Warrant } from '@idriszade/warrant-core';
import { generateKeyPair, issueWarrant, paramsHash } from '@idriszade/warrant-core';
import type { Ledger, LedgerEntry, LedgerAppendInput } from '@idriszade/warrant-ledger';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { err, ok } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { executeEmailQueue, EmailParamsSchema } from '../src/executor.js';
import type { EmailParams, ExecutorDeps } from '../src/executor.js';

const PRIV_HEX = 'a'.repeat(64);
const { publicKeyHex, privateKeyHex } = generateKeyPair(PRIV_HEX);
// Fixed dates: never use Date.now() in test fixtures (directive 3)
const ISSUE_DATE = new Date('2026-01-01T00:00:00Z');
const VERIFY_DATE = new Date('2026-01-01T00:00:30Z');

/**
 * makeWarrant issues a warrant whose paramsHash is computed over
 * EmailParamsSchema.parse(params), matching the executor's parse-then-hash step.
 * This ensures a legitimate warrant always verifies cleanly.
 */
function makeWarrant(params: unknown, ttlMs = 60_000, at = ISSUE_DATE, nonce = 'nonce-abc'): Warrant {
  // Parse so the hashed bytes match what the executor will hash (stripped + validated).
  // For non-schema-valid params (used in test (b)), we hash raw to simulate a warrant
  // issued over invalid bytes: the executor's schema check fires before hash compare.
  let hashableParams: unknown;
  try {
    hashableParams = EmailParamsSchema.parse(params);
  } catch {
    // Deliberately bad params: hash raw so paramsHash is bound to something,
    // but the executor will reject before reaching the compare anyway.
    hashableParams = params;
  }
  const r = issueWarrant(
    {
      request: {
        id: 'req-1', runId: 'run-1',
        principal: { kind: 'agent' as const, id: 'agent-1' },
        action: { kind: 'send_email', target: 'bob@example.com', params: hashableParams },
        context: { audience: 'cold', sentTodayByKind: {}, qaScore: 90 },
      },
      verdict: {
        path: 'auto' as const, ruleId: 'cold-email-hiring-manager',
        policyVersion: '0.1.0', policyHash: 'a'.repeat(64), reason: 'ok',
      },
      ttlMs,
    },
    { keys: { publicKeyHex, privateKeyHex }, now: () => at, newId: () => nonce },
  );
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

const VALID_PARAMS = EmailParamsSchema.parse({
  to: 'bob@example.com', subject: 'Hello', body: 'Body text',
});

// ─── existing tests (unchanged) ───────────────────────────────────────────────

describe('executeEmailQueue: happy path', () => {
  it('writes outbox file and appends 2 ledger events in order', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID_PARAMS);
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(result.error).toBeNull();
    expect(result.data?.outboxPath).toContain(warrant.id);

    const raw = await readFile(result.data!.outboxPath, 'utf-8');
    const fileContent = JSON.parse(raw) as { warrantId: string; params: { to: string } };
    expect(fileContent.warrantId).toBe(warrant.id);
    expect(fileContent.params.to).toBe(VALID_PARAMS.to);

    const all = await ledger.readAll();
    expect(all.error).toBeNull();
    const events = all.data!.map((e) => e.event);
    expect(events[0]).toBe('action.executed');
    expect(events[1]).toBe('action.outcome');
  });
});

describe('executeEmailQueue: params_mismatch', () => {
  it('returns integrity error and writes no ledger event or file', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID_PARAMS);
    const tampered = { ...VALID_PARAMS, subject: 'TAMPERED' };
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(warrant, tampered, deps);
    expect(result.error?.code).toBe('params_mismatch');
    expect(result.error?.type).toBe('integrity');
    const all = await ledger.readAll();
    expect(all.data).toHaveLength(0);
  });
});

describe('executeEmailQueue: expired warrant', () => {
  it('returns error before any ledger write', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    const ledger = new MemoryLedger();
    // issued at T+0, ttl=60s, verified at T+120s → expired
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const verifyAt = new Date('2026-01-01T00:02:00Z');
    const warrant = makeWarrant(VALID_PARAMS, 60_000, issuedAt);
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => verifyAt,
    };
    const result = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(result.error).not.toBeNull();
    const all = await ledger.readAll();
    expect(all.data).toHaveLength(0);
  });
});

describe('executeEmailQueue: ledger append failure on action.executed', () => {
  it('returns ledger error and writes no file when action.executed fails', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    const failLedger: Ledger = {
      append: async () => err<WarrantError>({
        type: 'transient', code: 'ledger_down', message: 'down',
      }),
      readRun: async () => ok([]),
      readAll: async () => ok([]),
    };
    const warrant = makeWarrant(VALID_PARAMS);
    const deps: ExecutorDeps = {
      ledger: failLedger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(result.error?.code).toBe('ledger_down');
    await expect(
      access(join(outboxDir, `${warrant.id}.json`)),
    ).rejects.toThrow();
  });
});

describe('executeEmailQueue: ledger append failure on action.outcome (step 7)', () => {
  it('returns outcome_append_failed AND outbox file exists', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    let appendCount = 0;
    const partialLedger: Ledger = {
      append: async (input: LedgerAppendInput) => {
        appendCount += 1;
        if (input.event === 'action.executed') {
          const entry: LedgerEntry = {
            seq: 1, prevHash: '0'.repeat(64), hash: 'a'.repeat(64),
            runId: input.runId, at: input.at, event: input.event,
            principal: input.principal, payload: input.payload,
          };
          return ok(entry);
        }
        return err<WarrantError>({
          type: 'transient', code: 'outcome_append_failed',
          message: 'outcome write failed',
        });
      },
      readRun: async () => ok([]),
      readAll: async () => ok([]),
    };
    const warrant = makeWarrant(VALID_PARAMS);
    const deps: ExecutorDeps = {
      ledger: partialLedger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(result.error?.code).toBe('outcome_append_failed');
    expect(result.error?.type).toBe('transient');
    await expect(
      access(join(outboxDir, `${warrant.id}.json`)),
    ).resolves.toBeUndefined();
    expect(appendCount).toBe(2);
  });
});

describe('executeEmailQueue: nonce reuse via MemoryLedger', () => {
  it('second execute with same warrant nonce returns nonce_spent', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-test-'));
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID_PARAMS);
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const first = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(first.error).toBeNull();
    const second = await executeEmailQueue(warrant, VALID_PARAMS, deps);
    expect(second.error?.code).toBe('nonce_spent');
  });
});

describe('GhostApproval invariant: property test', () => {
  it('any schema-valid params differing from approved never writes file and always returns params_mismatch', async () => {
    // Both approved and submitted must be schema-valid (email, non-empty strings) so that
    // the schema parse in step 3 succeeds and the hash-mismatch path (step 4) is exercised.
    // fast-check emailAddress() can produce addresses that Zod rejects: filter them out.
    const validEmailArb = fc.emailAddress().filter((e) => {
      try { EmailParamsSchema.shape.to.parse(e); return true; } catch { return false; }
    });
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          to: validEmailArb,
          subject: fc.string({ minLength: 1, maxLength: 80 }),
          body: fc.string({ minLength: 1, maxLength: 200 }),
        }),
        fc.record({
          to: validEmailArb,
          subject: fc.string({ minLength: 1, maxLength: 80 }),
          body: fc.string({ minLength: 1, maxLength: 200 }),
        }),
        async (approved, submitted) => {
          fc.pre(
            approved.to !== submitted.to ||
            approved.subject !== submitted.subject ||
            approved.body !== submitted.body,
          );
          const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-prop-'));
          const ledger = new MemoryLedger();
          const warrant = makeWarrant(approved);
          const deps: ExecutorDeps = {
            ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
          };
          const result = await executeEmailQueue(
            warrant,
            submitted as typeof VALID_PARAMS,
            deps,
          );
          expect(result.error?.code).toBe('params_mismatch');
          const all = await ledger.readAll();
          expect(all.data).toHaveLength(0);
        },
      ),
      { numRuns: 50, seed: 42 },
    );
  });
});

// ─── new security tests ────────────────────────────────────────────────────────

describe('executeEmailQueue: path traversal guard (CRITICAL 1)', () => {
  it('warrant.id with ../ returns unsafe_warrant_id, no file, no ledger entry', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-traversal-'));
    const ledger = new MemoryLedger();
    // Build a warrant with a path-traversal id by patching after issue
    const base = makeWarrant(VALID_PARAMS);
    const evil: Warrant = { ...base, id: '../escaped-warrant' };
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(evil, VALID_PARAMS, deps);
    expect(result.error?.code).toBe('unsafe_warrant_id');
    expect(result.error?.type).toBe('validation');
    // No ledger entries written
    const all = await ledger.readAll();
    expect(all.data).toHaveLength(0);
    // No file escaped outside outboxDir
    await expect(access(join(outboxDir, '../escaped-warrant.json'))).rejects.toThrow();
  });
});

describe('executeEmailQueue: schema validation (CRITICAL 2)', () => {
  // Code is `invalid_params`, not `invalid_email_params`: the parse moved into the shared guard
  // when it was extracted, and a guard that names the vendor in its error codes is not a guard.
  // The schema is still this actuator's; only the refusal is generic.
  it('malformed params (bad email, empty fields) returns invalid_params, no file, no ledger entry', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-schema-'));
    const ledger = new MemoryLedger();
    // Issue warrant over raw malformed bytes; executor schema check fires before hash compare
    const malformed = { to: 'not-an-email', subject: '', body: '' };
    const warrant = makeWarrant(malformed);
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(
      warrant,
      malformed as unknown as EmailParams,
      deps,
    );
    expect(result.error?.code).toBe('invalid_params');
    expect(result.error?.type).toBe('validation');
    const all = await ledger.readAll();
    expect(all.data).toHaveLength(0);
    await expect(access(join(outboxDir, `${warrant.id}.json`))).rejects.toThrow();
  });

  it('extra key on params is stripped: outbox file contains ONLY {to, subject, body}', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-strip-'));
    const ledger = new MemoryLedger();
    // Warrant issued over the CLEAN parsed params (no extra key in hash)
    const cleanParams = EmailParamsSchema.parse(VALID_PARAMS);
    const warrant = makeWarrant(cleanParams, 60_000, ISSUE_DATE, 'nonce-strip');
    // Caller passes params with an extra key injected
    const withExtra = { ...VALID_PARAMS, evil: 'injected' };
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    const result = await executeEmailQueue(
      warrant,
      withExtra as unknown as EmailParams,
      deps,
    );
    // Zod strips unknown keys; hash of parsed({to,subject,body}) still matches
    expect(result.error).toBeNull();
    const raw = await readFile(result.data!.outboxPath, 'utf-8');
    const written = JSON.parse(raw) as { params: Record<string, unknown> };
    expect(written.params).not.toHaveProperty('evil');
    expect(Object.keys(written.params)).toEqual(expect.arrayContaining(['to', 'subject', 'body']));
    expect(Object.keys(written.params)).toHaveLength(3);
  });
});

describe('executeEmailQueue: throw-safe writeFile (IMPORTANT)', () => {
  it('unwritable outboxDir returns outbox_write_failed without throwing', async () => {
    const outboxDir = await mkdtemp(join(tmpdir(), 'gtm-nowrite-'));
    // Make dir read-only so writeFile throws EACCES
    await chmod(outboxDir, 0o444);
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID_PARAMS, 60_000, ISSUE_DATE, 'nonce-nowrite');
    const deps: ExecutorDeps = {
      ledger, publicKeyHex, outboxDir, now: () => VERIFY_DATE,
    };
    try {
      const result = await executeEmailQueue(warrant, VALID_PARAMS, deps);
      expect(result.error?.code).toBe('outbox_write_failed');
      expect(result.error?.type).toBe('transient');

      // NEW behaviour from the guard extraction, and the reason it was worth doing. The nonce
      // is spent before the effect runs, so a failed write leaves authority consumed. The old
      // inline version returned here without appending action.outcome, leaving a ledger that
      // said "executed" and never said what happened: exactly the incomplete record the
      // ledger exists to prevent.
      const all = await ledger.readAll();
      expect(all.data!.map((e) => e.event)).toEqual(['action.executed', 'action.outcome']);
      expect(all.data![1]!.payload).toMatchObject({ status: 'failed' });
    } finally {
      // Restore perms so tmp cleanup works
      await chmod(outboxDir, 0o755);
    }
  });
});
