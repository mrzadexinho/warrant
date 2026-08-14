import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { err } from '@idriszade/core';
import pg from 'pg';
import { MemoryOutbox } from '../src/outbox.js';
import type { Outbox, OutboxRow } from '../src/outbox.js';
import { PostgresOutbox, PostgresDrainerLock, DRAINER_LOCK_KEY } from '../src/outbox-pg.js';
import { runOutboxConformance } from './outbox-conformance.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

// An outbox whose backend always errors: exercises the "typed err, never throws" contract
// for the Memory implementation, which has no real failure mode of its own (a Map cannot
// reject). Mirrors FailingParkStore in park-store.test.ts.
class FailingOutbox implements Outbox {
  async enqueue(_row: OutboxRow) {
    return err({ type: 'transient' as const, code: 'db_error', message: 'backend unavailable' });
  }
  async listPending(_limit?: number) {
    return err({ type: 'transient' as const, code: 'db_error', message: 'backend unavailable' });
  }
  async retire(_requestId: string) {
    return err({ type: 'transient' as const, code: 'db_error', message: 'backend unavailable' });
  }
}

describe('MemoryOutbox conformance', () => {
  runOutboxConformance(
    'MemoryOutbox',
    async () => new MemoryOutbox(),
    async () => new FailingOutbox(),
  );
});

describe('PostgresDrainerLock without a database', () => {
  it('acquire returns false (never throws) when the pool cannot hand out a connection', async () => {
    const pool = { connect: async () => { throw new Error('connection refused'); } } as unknown as pg.Pool;
    const lock = new PostgresDrainerLock(pool);
    await expect(lock.acquire()).resolves.toBe(false);
  });

  it('acquire returns false (never throws) when the lock query itself rejects, and releases the client', async () => {
    let released = 0;
    const client = {
      query: async () => { throw new Error('server closed the connection'); },
      release: () => { released += 1; },
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const lock = new PostgresDrainerLock(pool);
    await expect(lock.acquire()).resolves.toBe(false);
    expect(released).toBe(1);
  });

  it('release without a prior acquire is a no-op and never touches the pool', async () => {
    const pool = { connect: async () => { throw new Error('must not connect'); } } as unknown as pg.Pool;
    await expect(new PostgresDrainerLock(pool).release()).resolves.toBeUndefined();
  });

  it('release swallows a failing unlock query and still returns the client to the pool', async () => {
    let released = 0;
    const client = {
      query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        throw new Error('unlock failed: server closed the connection');
      },
      release: () => { released += 1; },
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const lock = new PostgresDrainerLock(pool);
    expect(await lock.acquire()).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(released).toBe(1);
  });

  it('release swallows a client.release that throws', async () => {
    const client = {
      query: async () => ({ rows: [{ locked: true }] }),
      release: () => { throw new Error('client already released'); },
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;
    const lock = new PostgresDrainerLock(pool);
    expect(await lock.acquire()).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  // The unsigned-key defect that made every warrant-ledger append fail with 22003 (see the
  // CHAIN_LOCK comment in warrant-ledger/src/postgres.ts): the drainer lock derives its key
  // the same way, so it must land inside int8's range, and it must use a DIFFERENT seed so
  // draining never serializes against chain appends.
  it('DRAINER_LOCK_KEY is a signed 64-bit key derived from a seed other than the chain lock', () => {
    const derive = (seed: string): bigint => BigInt.asIntN(
      64, BigInt('0x' + createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)),
    );
    expect(DRAINER_LOCK_KEY).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(DRAINER_LOCK_KEY).toBeLessThanOrEqual(2n ** 63n - 1n);
    expect(DRAINER_LOCK_KEY).toBe(derive('warrant-eve-outbox-drainer'));
    // The seed is chosen so the signed conversion actually does something: without asIntN
    // the key is 17173175722131980601, far outside int8, and Postgres raises 22003.
    expect(DRAINER_LOCK_KEY).toBeLessThan(0n);
    expect(DRAINER_LOCK_KEY).not.toBe(derive('warrant-ledger'));
  });
});

describe.skipIf(!DB_URL)('PostgresOutbox conformance', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL! });
    await new PostgresOutbox(pool).ensureTable();
  });
  afterAll(async () => { await pool.end(); });

  runOutboxConformance(
    'PostgresOutbox',
    async () => {
      await pool.query('TRUNCATE warrant_eve_outbox');
      return new PostgresOutbox(pool);
    },
    async () => {
      const failingPool = { query: async () => { throw new Error('connection refused'); } } as unknown as pg.Pool;
      return new PostgresOutbox(failingPool);
    },
  );
});

describe.skipIf(!DB_URL)('PostgresDrainerLock against a real database', () => {
  let pool: pg.Pool;
  beforeAll(async () => { pool = new pg.Pool({ connectionString: DB_URL! }); });
  afterAll(async () => { await pool.end(); });

  it('a second lock cannot acquire while the first holds it, and can after release', async () => {
    const a = new PostgresDrainerLock(pool);
    const b = new PostgresDrainerLock(pool);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });

  // pg_try_advisory_lock is re-entrant within one session, so a second acquire on the same
  // instance would return true and the first release would then leave the lock held. The
  // refusal is measured against a single-connection pool because that is where its absence
  // is not merely wasteful: without it, the second acquire waits forever for the pool's only
  // connection, which this very lock is holding. A self-deadlock, not a false.
  it('the same lock instance refuses a second acquire instead of deadlocking a max:1 pool', async () => {
    const singlePool = new pg.Pool({ connectionString: DB_URL!, max: 1 });
    try {
      const a = new PostgresDrainerLock(singlePool);
      expect(await a.acquire()).toBe(true);
      expect(await a.acquire()).toBe(false);
      await a.release();
    } finally {
      await singlePool.end();
    }
  });

  it('release is idempotent and never throws', async () => {
    const a = new PostgresDrainerLock(pool);
    expect(await a.acquire()).toBe(true);
    await a.release();
    await expect(a.release()).resolves.toBeUndefined();
    const b = new PostgresDrainerLock(pool);
    expect(await b.acquire()).toBe(true);
    await b.release();
  });
});
