import { createHash } from 'node:crypto';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type pg from 'pg';
import type { WarrantError } from '@idriszade/warrant-core';
import { GENESIS_PREV_HASH, entryHash } from './entry.js';
import type { LedgerAppendInput, LedgerEntry, Ledger } from './entry.js';

// Advisory-lock key derived from sha256('warrant-ledger'): a stable, arbitrary
// constant so every process serializes chain appends on the same lock.
//
// asIntN(64, ...) is REQUIRED, not cosmetic. pg_advisory_xact_lock takes a
// SIGNED bigint. The first 16 hex chars of this digest are 0xc83279f58baa6955 =
// 14425726651938269525, which exceeds int8's maximum of 9223372036854775807, so
// the unsigned value made Postgres raise 22003 ("value out of range for type
// bigint") on EVERY append. The catch block mapped that to a generic db_error,
// so the PostgresLedger silently wrote nothing at all, and the advisory lock
// that C5's TOCTOU close depends on never engaged once. It went unnoticed
// because the Postgres conformance tests are env-gated and skip without a
// database. See the chain-lock range test in tests/postgres-lock.test.ts.
const CHAIN_LOCK = BigInt.asIntN(
  64,
  BigInt('0x' + createHash('sha256').update('warrant-ledger', 'utf8').digest('hex').slice(0, 16)),
);

/** Exported for the range test. Postgres advisory locks take a signed 64-bit key. */
export const CHAIN_LOCK_KEY = CHAIN_LOCK;

function rowToEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    seq: Number(row['seq']),
    runId: row['run_id'] as string,
    at: row['at'] instanceof Date ? (row['at'] as Date).toISOString() : (row['at'] as string),
    event: row['event'] as LedgerEntry['event'],
    principal: typeof row['principal'] === 'string'
      ? JSON.parse(row['principal'] as string) as LedgerEntry['principal']
      : row['principal'] as LedgerEntry['principal'],
    payload: typeof row['payload'] === 'string'
      ? JSON.parse(row['payload'] as string)
      : row['payload'],
    prevHash: row['prev_hash'] as string,
    hash: row['hash'] as string,
  };
}

function getNonce(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'nonce' in payload) {
    const n = (payload as Record<string, unknown>)['nonce'];
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

export class PostgresLedger implements Ledger {
  constructor(private readonly pool: pg.Pool) {}

  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS warrant_ledger (
        seq       BIGINT PRIMARY KEY,
        run_id    TEXT NOT NULL,
        at        TIMESTAMPTZ NOT NULL,
        event     TEXT NOT NULL,
        principal JSONB NOT NULL,
        payload   JSONB NOT NULL,
        prev_hash TEXT NOT NULL,
        hash      TEXT NOT NULL
      )
    `);
    // Fix #4: belt-and-suspenders UNIQUE index, which prevents double-spend even if advisory-lock
    // logic ever regresses. The in-transaction SELECT check still runs first to yield the
    // clean nonce_spent error; this index is the backstop.
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS warrant_ledger_nonce_uniq
        ON warrant_ledger ((payload->>'nonce'))
        WHERE event = 'action.executed'
    `);
    // Claim uniqueness (master C5, the concurrent-resume TOCTOU close): at most one entry per
    // (event, reviewId) and one per (event, reviewRef). Postgres treats a missing key as NULL
    // in both expressions, and a unique index never restricts NULLs, so the auto path's
    // warrant.issued (neither reviewId nor reviewRef) is completely unconstrained.
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS warrant_ledger_review_uniq
        ON warrant_ledger (event, (payload->>'reviewId'))
        WHERE payload ? 'reviewId'
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS warrant_ledger_reviewref_uniq
        ON warrant_ledger (event, (payload->>'reviewRef'))
        WHERE payload ? 'reviewRef'
    `);
  }

  async append(input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);

      if (input.event === 'action.executed') {
        const nonce = getNonce(input.payload);
        if (nonce !== undefined) {
          const chk = await client.query(
            `SELECT 1 FROM warrant_ledger WHERE event = 'action.executed' AND payload->>'nonce' = $1 LIMIT 1`,
            [nonce],
          );
          if (chk.rowCount && chk.rowCount > 0) {
            await client.query('ROLLBACK');
            return err({ type: 'integrity', code: 'nonce_spent', message: `Nonce already spent: ${nonce}` });
          }
        }
      }

      const tail = await client.query('SELECT seq, hash FROM warrant_ledger ORDER BY seq DESC LIMIT 1');
      const rawPrev = tail.rows[0] as { seq: string | number; hash: string } | undefined;
      // pg returns BIGINT columns as JS strings, so coerce via Number() before arithmetic
      const seq = rawPrev ? Number(rawPrev.seq) + 1 : 1;
      const prevHash = rawPrev ? rawPrev.hash : GENESIS_PREV_HASH;
      // input spreads FIRST, same reason as MemoryLedger.append. It matters more here:
      // the INSERT below writes the COMPUTED seq and prevHash while entryHash was taken
      // over `base`, so a caller-supplied seq produced a persisted row whose hash did
      // not match its own columns, and the chain was unverifiable from that row onward.
      const base = { ...input, seq, prevHash };
      // Fix #2: wrap entryHash (which calls canonicalJson): non-plain payloads throw; must not propagate
      let hash: string;
      try {
        hash = entryHash(base);
      } catch (e) {
        await client.query('ROLLBACK');
        return err({ type: 'integrity', code: 'noncanonical_payload', message: String(e) });
      }

      await client.query(
        `INSERT INTO warrant_ledger (seq, run_id, at, event, principal, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [seq, input.runId, input.at, input.event, JSON.stringify(input.principal), JSON.stringify(input.payload), prevHash, hash],
      );
      await client.query('COMMIT');
      return ok({ ...base, hash });
    } catch (e) {
      await client.query('ROLLBACK');
      // Key strictly on the constraint name, never on 23505 alone: a nonce collision must
      // still surface as nonce_spent (it has its own SELECT precheck above, so this branch is
      // only the belt-and-suspenders backstop noted in ensureTable), and a 23505 on any other
      // constraint falls through to db_error rather than being blanket-mapped.
      const pgErr = e as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'warrant_ledger_nonce_uniq') {
        return err({ type: 'integrity', code: 'nonce_spent', message: `Nonce already spent: ${String(e)}` });
      }
      if (pgErr.code === '23505' &&
          (pgErr.constraint === 'warrant_ledger_review_uniq' || pgErr.constraint === 'warrant_ledger_reviewref_uniq')) {
        return err({ type: 'integrity', code: 'duplicate_review_claim', message: `Duplicate review claim: ${String(e)}` });
      }
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    } finally {
      client.release();
    }
  }

  async readRun(runId: string): Promise<Result<LedgerEntry[], WarrantError>> {
    try {
      const r = await this.pool.query('SELECT * FROM warrant_ledger WHERE run_id=$1 ORDER BY seq', [runId]);
      return ok((r.rows as Record<string, unknown>[]).map(rowToEntry));
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }

  async readAll(): Promise<Result<LedgerEntry[], WarrantError>> {
    try {
      const r = await this.pool.query('SELECT * FROM warrant_ledger ORDER BY seq');
      return ok((r.rows as Record<string, unknown>[]).map(rowToEntry));
    } catch (e) {
      return err({ type: 'transient', code: 'db_error', message: String(e) });
    }
  }
}
