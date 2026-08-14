// Proves the advisory lock serializes concurrent appends WITHOUT losing writes or corrupting
// the chain, under real concurrency rather than by reading src/postgres.ts and trusting the
// comment. 50 concurrent append() calls on one runId, fired via Promise.all over 50 un-awaited
// invocations: all 50 must land, their seq values must be a gapless, duplicate-free 1..50
// sequence, and the resulting chain must verify (prevHash links, stored hash matches
// recomputed entryHash) end to end.
//
// The Postgres half is gated on WARRANT_TEST_DATABASE_URL exactly like
// tests/conformance-postgres.test.ts and tests/append-only-live.test.ts, and uses a
// process-unique schema (same SUFFIX idiom as append-only-live.test.ts) so a parallel vitest
// worker running another Postgres-gated file cannot collide with this one.
//
// No `verifyChain` import from @idriszade/warrant-verify: that package is not a dependency of
// @idriszade/warrant-ledger (checked: not in package.json, not resolvable from this package's
// node_modules). The chain check below is written locally against this package's own exported
// primitives (`GENESIS_PREV_HASH`, `entryHash`), the same idiom already used in
// tests/conformance.ts's "persistence roundtrip" case and tests/tamper.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { MemoryLedger } from '../src/memory.js';
import { PostgresLedger } from '../src/postgres.js';
import { GENESIS_PREV_HASH, entryHash } from '../src/entry.js';
import type { Ledger, LedgerEntry } from '../src/entry.js';

const CONCURRENCY = 50;
const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

/** Local stand-in for warrant-verify's verifyChain: gapless seq, linked prevHash, matching hash. */
function assertCleanChain(entries: LedgerEntry[], expectedCount: number): void {
  expect(entries).toHaveLength(expectedCount);
  const seqs = entries.map((e) => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: expectedCount }, (_, i) => i + 1));
  // Duplicate-free is implied by the strictly-increasing 1..N check above, but assert it
  // directly too: a set of size N from N values is the definition of "no duplicates".
  expect(new Set(seqs).size).toBe(expectedCount);

  const bySeq = [...entries].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < bySeq.length; i++) {
    const e = bySeq[i]!;
    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : bySeq[i - 1]!.hash;
    expect(e.prevHash).toBe(expectedPrev);
    const { hash, ...rest } = e;
    expect(hash).toBe(entryHash(rest));
  }
}

async function fireConcurrentAppends(ledger: Ledger, runId: string) {
  return Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      ledger.append({
        runId,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        event: 'warrant.requested',
        principal: { kind: 'agent', id: 'concurrent-agent' },
        payload: { i },
      }),
    ),
  );
}

describe('Ledger: 50 concurrent appends on one runId (MemoryLedger)', () => {
  it('all 50 land with a gapless, duplicate-free seq and a clean chain', async () => {
    const ledger = new MemoryLedger();
    const results = await fireConcurrentAppends(ledger, 'concurrent-run-memory');

    expect(results.every((r) => r.error === null)).toBe(true);

    const entries = (await ledger.readAll()).data!;
    assertCleanChain(entries, CONCURRENCY);
  });
});

describe.skipIf(!DB_URL)('Ledger: 50 concurrent appends on one runId (PostgresLedger)', () => {
  const SUFFIX = `${process.pid}_${Date.now()}`;
  const SCHEMA = `wl_concurrent_${SUFFIX}`;
  let pool: pg.Pool;
  let ledger: PostgresLedger;

  beforeAll(async () => {
    const bootstrap = new pg.Pool({ connectionString: DB_URL! });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();
    pool = new pg.Pool({ connectionString: DB_URL!, options: `-c search_path=${SCHEMA}` });
    ledger = new PostgresLedger(pool);
    await ledger.ensureTable();
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } catch {
        /* best effort */
      }
      await pool.end();
    }
  });

  it('all 50 land with a gapless, duplicate-free seq and a clean chain, serialized through the advisory lock', async () => {
    const results = await fireConcurrentAppends(ledger, 'concurrent-run-postgres');

    // FINDING guard, not a weakened assertion: if this backend is ever genuinely nondeterministic
    // in OUTCOME (some of the 50 silently fail rather than serialize) that must fail loudly here,
    // not be masked by a partial-success allowance.
    expect(results.every((r) => r.error === null)).toBe(true);

    const entries = (await ledger.readAll()).data!;
    assertCleanChain(entries, CONCURRENCY);
  });
});
