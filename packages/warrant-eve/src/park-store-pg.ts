// PostgresParkStore (C1): mirrors warrant-ledger/src/postgres.ts's style. Holds NO
// authorization data (see park-store.ts summary comment); table is a plain upsertable
// key-value record keyed on review_id, not a chain.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type pg from 'pg';
import type { WarrantError } from '@idriszade/warrant-core';
import type { ParkRecord, ParkStore } from './park-store.js';

function rowToRecord(row: Record<string, unknown>): ParkRecord {
  return {
    reviewId: row['review_id'] as string,
    runId: row['run_id'] as string,
    callId: row['call_id'] as string,
    eveRequestId: row['eve_request_id'] as string,
    continuationToken: row['continuation_token'] as string,
    parkedAt: row['parked_at'] instanceof Date
      ? (row['parked_at'] as Date).toISOString() : (row['parked_at'] as string),
  };
}

export class PostgresParkStore implements ParkStore {
  constructor(private readonly pool: pg.Pool) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS warrant_eve_parks (
        review_id          TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL,
        call_id            TEXT NOT NULL,
        eve_request_id     TEXT NOT NULL,
        continuation_token TEXT NOT NULL,
        parked_at          TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async put(rec: ParkRecord): Promise<Result<void, WarrantError>> {
    try {
      await this.pool.query(
        `INSERT INTO warrant_eve_parks
           (review_id, run_id, call_id, eve_request_id, continuation_token, parked_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (review_id) DO UPDATE SET
           run_id = EXCLUDED.run_id, call_id = EXCLUDED.call_id,
           eve_request_id = EXCLUDED.eve_request_id,
           continuation_token = EXCLUDED.continuation_token, parked_at = EXCLUDED.parked_at`,
        [rec.reviewId, rec.runId, rec.callId, rec.eveRequestId, rec.continuationToken, rec.parkedAt],
      );
      return ok(undefined);
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }

  async get(reviewId: string): Promise<Result<ParkRecord | null, WarrantError>> {
    try {
      const r = await this.pool.query('SELECT * FROM warrant_eve_parks WHERE review_id=$1', [reviewId]);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      return ok(row ? rowToRecord(row) : null);
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }
}
