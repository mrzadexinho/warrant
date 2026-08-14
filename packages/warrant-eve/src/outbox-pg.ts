// PostgresOutbox + PostgresDrainerLock (§8, contracts P1/P2): mirrors park-store-pg.ts's
// style. The table is a plain work list keyed on request_id, not a chain, and carries no
// `sent` column by design (see the outbox.ts summary: the ledger is the only authority on
// whether an action was sent).
//
// PostgresDrainerLock holds a session-level advisory lock on a DEDICATED connection. It must
// not use pool.query: the pool can hand a different connection to the release call, which
// would leave the lock held for the life of the acquiring connection.
import { createHash } from 'node:crypto';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type pg from 'pg';
import type { WarrantError } from '@idriszade/warrant-core';
import { DEFAULT_OUTBOX_LIMIT } from './outbox.js';
import type { DrainerLock, Outbox, OutboxRow } from './outbox.js';

// Advisory-lock key derived from sha256('warrant-eve-outbox-drainer'). A DIFFERENT seed from
// warrant-ledger's 'warrant-ledger' CHAIN_LOCK on purpose: the drainer must not serialize
// against chain appends, it only excludes other drainers.
//
// asIntN(64, ...) is REQUIRED, not cosmetic, for the same reason it is required there:
// pg_try_advisory_lock takes a SIGNED bigint, and an unsigned key made every warrant-ledger
// append raise 22003 ("value out of range for type bigint"), which the catch block mapped to
// a generic db_error while the lock never engaged once. This seed's first 16 hex digits are
// 0xee0c5f41e1934339, whose high bit IS set, so the conversion is load-bearing here and not
// merely defensive: drop it and every acquire against a real database raises 22003 and
// silently returns false. See the range test in tests/outbox.test.ts.
const DRAINER_LOCK = BigInt.asIntN(
  64,
  BigInt('0x' + createHash('sha256').update('warrant-eve-outbox-drainer', 'utf8').digest('hex').slice(0, 16)),
);

/** Exported for the range test. Postgres advisory locks take a signed 64-bit key. */
export const DRAINER_LOCK_KEY = DRAINER_LOCK;

function rowToOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    requestId: row['request_id'] as string,
    runId: row['run_id'] as string,
    params: row['params'],
    enqueuedAt: row['enqueued_at'] instanceof Date
      ? (row['enqueued_at'] as Date).toISOString() : (row['enqueued_at'] as string),
  };
}

export class PostgresOutbox implements Outbox {
  constructor(private readonly pool: pg.Pool) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS warrant_eve_outbox (
        request_id  TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        params      JSONB NOT NULL,
        enqueued_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  // DO NOTHING, not DO UPDATE: first write wins (see MemoryOutbox.enqueue for why).
  async enqueue(row: OutboxRow): Promise<Result<void, WarrantError>> {
    try {
      // params is stringified explicitly and cast, rather than handed to pg as an object:
      // pg turns a top-level JS array into a Postgres ARRAY literal, which is not jsonb.
      await this.pool.query(
        `INSERT INTO warrant_eve_outbox (request_id, run_id, params, enqueued_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (request_id) DO NOTHING`,
        [row.requestId, row.runId, JSON.stringify(row.params), row.enqueuedAt],
      );
      return ok(undefined);
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }

  async listPending(limit?: number): Promise<Result<OutboxRow[], WarrantError>> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM warrant_eve_outbox
         ORDER BY enqueued_at ASC, request_id ASC
         LIMIT $1`,
        [limit ?? DEFAULT_OUTBOX_LIMIT],
      );
      return ok((r.rows as Record<string, unknown>[]).map(rowToOutboxRow));
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }

  // The one DELETE in this class, and it is why the LIMIT above does not starve newer rows.
  // It records nothing: the ledger still holds the only statement about whether the action sent.
  async retire(requestId: string): Promise<Result<void, WarrantError>> {
    try {
      await this.pool.query('DELETE FROM warrant_eve_outbox WHERE request_id = $1', [requestId]);
      return ok(undefined);
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }
}

export class PostgresDrainerLock implements DrainerLock {
  private client: pg.PoolClient | null = null;

  constructor(private readonly pool: pg.Pool) {}

  async acquire(): Promise<boolean> {
    // pg_try_advisory_lock is re-entrant within one session: a second acquire on the same
    // connection would return true, and the first release would then leave it held.
    if (this.client !== null) return false;
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return false;
    }
    try {
      const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DRAINER_LOCK]);
      const locked = (r.rows[0] as { locked?: unknown } | undefined)?.locked === true;
      if (!locked) {
        client.release();
        return false;
      }
      this.client = client;
      return true;
    } catch {
      client.release();
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    this.client = null;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [DRAINER_LOCK]);
    } catch { /* the connection is going back to the pool either way */ }
    try {
      client.release();
    } catch { /* release() on an already-released client must not surface */ }
  }
}
