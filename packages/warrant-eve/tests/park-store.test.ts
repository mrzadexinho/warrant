import { describe, beforeAll, afterAll } from 'vitest';
import { err } from '@idriszade/core';
import pg from 'pg';
import { MemoryParkStore } from '../src/park-store.js';
import type { ParkStore, ParkRecord } from '../src/park-store.js';
import { PostgresParkStore } from '../src/park-store-pg.js';
import { runParkStoreConformance } from './park-store-conformance.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

// A store whose backend always errors: exercises the "typed err, never throws,
// never partial" contract for the Memory implementation, which has no real failure
// mode of its own (a Map can't reject). Mirrors the hand-rolled Gate/Ledger stubs
// used elsewhere in this package's tests (e.g. resume.test.ts's `badGate`).
class FailingParkStore implements ParkStore {
  async put(_rec: ParkRecord) {
    return err({ type: 'transient' as const, code: 'db_error', message: 'backend unavailable' });
  }
  async get(_reviewId: string) {
    return err({ type: 'transient' as const, code: 'db_error', message: 'backend unavailable' });
  }
}

describe('MemoryParkStore conformance', () => {
  runParkStoreConformance(
    'MemoryParkStore',
    async () => new MemoryParkStore(),
    async () => new FailingParkStore(),
  );
});

describe.skipIf(!DB_URL)('PostgresParkStore conformance', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL! });
    await new PostgresParkStore(pool).ensureTable();
  });
  afterAll(async () => { await pool.end(); });

  runParkStoreConformance(
    'PostgresParkStore',
    async () => {
      await pool.query('TRUNCATE warrant_eve_parks');
      return new PostgresParkStore(pool);
    },
    async () => {
      // Pool stub whose query always rejects: exercises PostgresParkStore's try/catch
      // without needing a real broken connection.
      const failingPool = { query: async () => { throw new Error('connection refused'); } } as unknown as pg.Pool;
      return new PostgresParkStore(failingPool);
    },
  );
});
