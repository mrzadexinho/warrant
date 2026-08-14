import { describe, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresLedger } from '../src/postgres.js';
import { runLedgerConformance } from './conformance.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

describe.skipIf(!DB_URL)('PostgresLedger conformance', () => {
  let pool: pg.Pool;

  // Each Postgres test FILE gets its own schema. Truncating between tests is not
  // enough on its own: vitest runs files in parallel workers, so postgres-smoke
  // was inserting into the same warrant_ledger table between this file's TRUNCATE
  // and its `seq === 1` assertion. The two files could never pass in one run, and
  // it stayed invisible because both skip without a database.
  beforeAll(async () => {
    const bootstrap = new pg.Pool({ connectionString: DB_URL! });
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS wl_conformance');
    await bootstrap.end();
    pool = new pg.Pool({ connectionString: DB_URL!, options: '-c search_path=wl_conformance' });
    const ledger = new PostgresLedger(pool);
    await ledger.ensureTable();
  });

  afterAll(async () => { await pool.end(); });

  // Factory invoked in beforeEach: TRUNCATEs + returns a fresh PostgresLedger each test.
  runLedgerConformance('PostgresLedger', async () => {
    await pool.query('TRUNCATE warrant_ledger RESTART IDENTITY CASCADE');
    return new PostgresLedger(pool);
  });
});
