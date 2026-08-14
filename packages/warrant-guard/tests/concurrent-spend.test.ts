/**
 * Proves nonce single-spend under REAL concurrency, through the actual enforcement seam
 * (`guardedExecute`), not by reading the source and trusting the sequential story that
 * `guarded-execute.test.ts`'s "refuses a second execution" test already tells.
 *
 * One warrant, fired at 50 concurrent `guardedExecute` calls via `Promise.all` over 50
 * un-awaited invocations. Exactly one must win; the other 49 must be refused with the ledger's
 * own `nonce_spent` code (never a generic failure); the effect must run exactly once; the
 * ledger must hold exactly one `action.executed` for that nonce.
 *
 * MemoryLedger runs unconditionally. A PostgresLedger variant was in scope for this file, but
 * @idriszade/warrant-guard does not depend on `pg` (only on @idriszade/warrant-ledger, which
 * re-exports `PostgresLedger` but not a way to construct a `pg.Pool` without importing `pg`
 * directly): see the FINDING at the bottom of this file. The Postgres proof of single-spend
 * under concurrency is instead covered at the ledger level by
 * packages/warrant-ledger/tests/concurrent-append.test.ts, which already depends on `pg`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ok } from '@idriszade/core';
import type { Warrant } from '@idriszade/warrant-core';
import { generateKeyPair, issueWarrant } from '@idriszade/warrant-core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { guardedExecute } from '../src/index.js';
import type { GuardDeps } from '../src/index.js';

const { publicKeyHex, privateKeyHex } = generateKeyPair('c'.repeat(64));
const ISSUE_AT = new Date('2026-01-01T00:00:00Z');
const ACT_AT = new Date('2026-01-01T00:00:30Z');

const TicketSchema = z.object({ ticketId: z.string().min(1), severity: z.number().int().min(1).max(5) });
const VALID = { ticketId: 'INC-CONCURRENT', severity: 2 };

function makeWarrant(): Warrant {
  const r = issueWarrant(
    {
      request: {
        id: 'req-concurrent', runId: 'run-concurrent',
        principal: { kind: 'agent' as const, id: 'agent-concurrent' },
        action: { kind: 'open_ticket', target: 'svc-a', params: VALID },
        context: { entityId: 'e-1' },
      },
      verdict: {
        path: 'auto' as const, ruleId: 'auto-ticket',
        policyVersion: '0.1.0', policyHash: 'd'.repeat(64), reason: 'ok',
      },
      ttlMs: 60_000,
    },
    { keys: { publicKeyHex, privateKeyHex }, now: () => ISSUE_AT, newId: () => 'nonce-concurrent' },
  );
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

const CONCURRENCY = 50;

describe('guardedExecute: nonce single-spend under real concurrency (MemoryLedger)', () => {
  it('exactly one of 50 concurrent calls wins; the effect runs exactly once; the ledger holds exactly one action.executed for the nonce', async () => {
    const ledger = new MemoryLedger();
    const warrant = makeWarrant();
    const deps: GuardDeps = { publicKeyHex, ledger, now: () => ACT_AT, outcomeStatus: 'opened' };

    let effectRunCount = 0;
    const effect = async () => {
      effectRunCount += 1;
      return ok('done');
    };

    // 50 un-awaited invocations, fired together: Promise.all is the barrier, not each call.
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => guardedExecute(warrant, VALID, TicketSchema, deps, effect)),
    );

    const okResults = results.filter((r) => r.error === null);
    const refused = results.filter((r) => r.error !== null);

    expect(okResults).toHaveLength(1);
    expect(refused).toHaveLength(CONCURRENCY - 1);
    // The exact refusal code the ledger surfaces on a nonce collision: not guessed, read from
    // packages/warrant-ledger/src/memory.ts and postgres.ts: `{ type: 'integrity', code:
    // 'nonce_spent', ... }`.
    expect(refused.every((r) => r.error?.code === 'nonce_spent')).toBe(true);
    expect(refused.every((r) => r.error?.type === 'integrity')).toBe(true);

    expect(effectRunCount).toBe(1);

    const entries = (await ledger.readAll()).data!;
    const executedForNonce = entries.filter(
      (e) => e.event === 'action.executed' && (e.payload as { nonce?: string }).nonce === warrant.nonce,
    );
    expect(executedForNonce).toHaveLength(1);
  });
});

// FINDING (not a weakened assertion: a scope gap): the briefing asked for this file to also
// run the same 50-way concurrent proof against PostgresLedger, gated on
// WARRANT_TEST_DATABASE_URL exactly like packages/warrant-ledger/tests/append-only-live.test.ts.
// That requires constructing a `pg.Pool` to hand to `PostgresLedger`, which requires importing
// `pg`: and `pg` is not a dependency of @idriszade/warrant-guard (checked: not in
// package.json, not resolvable from this package's node_modules under pnpm's non-hoisted
// layout). Adding it would mean editing packages/warrant-guard/package.json and running
// `pnpm install`, both out of scope for this task. Left undone here rather than worked around
// with a relative import into a sibling package's node_modules (a phantom-dependency hack that
// pnpm's strict layout exists to prevent). The Postgres single-spend-under-concurrency proof
// still exists: at the ledger level, in concurrent-append.test.ts: it just does not additionally
// exercise the guardedExecute pipeline on top of Postgres.
