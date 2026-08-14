import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { PostgresLedger } from '../src/postgres.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

describe.skipIf(!DB_URL)('PostgresLedger smoke', () => {
  it('creates table and appends an entry with seq=1', async () => {
    // Own schema: vitest runs test files in parallel workers, and sharing one
    // warrant_ledger table with conformance-postgres made both files' seq
    // assertions race. See the comment in conformance-postgres.test.ts.
    const bootstrap = new pg.Pool({ connectionString: DB_URL! });
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS wl_smoke');
    await bootstrap.end();
    const pool = new pg.Pool({ connectionString: DB_URL!, options: '-c search_path=wl_smoke' });
    const ledger = new PostgresLedger(pool);
    await ledger.ensureTable();
    await pool.query('TRUNCATE warrant_ledger RESTART IDENTITY CASCADE');
    const r = await ledger.append({
      runId: 'pg-smoke', at: '2026-07-16T00:00:00.000Z', event: 'warrant.requested',
      principal: { kind: 'agent', id: 'smoke-agent' }, payload: { smoke: true },
    });
    expect(r.error).toBeNull();
    expect(r.data!.seq).toBe(1);
    expect(r.data!.hash).toHaveLength(64);
    await pool.end();
  });
});
