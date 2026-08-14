// Runtime grants for the two tables warrant-eve owns (design spec section 3.3).
//
// WHY THIS EXISTS: the ceremony runs the DDL as an ADMIN role and the application as a separate
// least-privilege role, which is what makes warrant-ledger's append-only guards mean anything. But
// a table created by admin grants PUBLIC nothing, and applyAppendOnlyGuards only speaks about
// warrant_ledger. So the app role ended up with no privilege at all on warrant_eve_parks and
// warrant_eve_outbox, and the first governed call that parked would have failed on
// `permission denied for table warrant_eve_parks`, after the review was already created.
//
// It survived every test because every Postgres test in this repo runs as ONE role that owns the
// tables it writes, which is precisely the configuration where this cannot appear.
//
// These two tables are deliberately NOT append-only, and that is not an oversight: neither holds
// authorization data. A park record only routes an eve resume, and an outbox row is re-verified
// against the signed warrant before a byte is sent. They are working state, so the runtime gets
// full DML on them and nothing else. Read the ledger's append-only module for the table where the
// opposite rule applies.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type pg from 'pg';
import type { WarrantError } from '@idriszade/warrant-core';

/** The tables PostgresParkStore.ensureTable and PostgresOutbox.ensureTable create. */
export const RUNTIME_TABLES = ['warrant_eve_parks', 'warrant_eve_outbox'] as const;

// GRANT accepts no bind parameters, so the role is interpolated into the statement text and this
// regex is the only thing standing between a caller-supplied name and live SQL. Same rule and same
// reasoning as warrant-ledger/src/append-only.ts, including the 63-byte identifier bound Postgres
// truncates at silently.
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ROLE_LEN = 63;

export interface RuntimeGrantsOptions {
  /** The least-privilege application role the runtime connects as. */
  role: string;
}

/** The ordered statement list. Pure: no connection, no clock, no environment. */
export function runtimeGrantsSql(opts: RuntimeGrantsOptions): Result<string[], WarrantError> {
  if (!SQL_IDENTIFIER.test(opts.role) || opts.role.length > MAX_ROLE_LEN) {
    return err({
      type: 'validation',
      code: 'invalid_identifier',
      message: `Invalid SQL identifier for role: ${JSON.stringify(opts.role)}`,
    });
  }
  return ok(
    RUNTIME_TABLES.map((t) => `GRANT INSERT, SELECT, UPDATE, DELETE ON ${t} TO ${opts.role}`),
  );
}

/**
 * Runs the grants in one transaction, then VERIFIES the end state before returning ok.
 *
 * The verification is the half that matters. `ok` must mean "the runtime can write these tables",
 * not "the GRANT statements did not raise", because the failure this closes was invisible precisely
 * because nothing ever asked the database what the role could actually do.
 */
export async function applyRuntimeGrants(
  pool: pg.Pool,
  opts: RuntimeGrantsOptions,
): Promise<Result<void, WarrantError>> {
  const statements = runtimeGrantsSql(opts);
  if (statements.error !== null) return err(statements.error);

  const client = await pool.connect().catch(() => null);
  if (client === null) {
    return err({ type: 'transient', code: 'runtime_grants_failed', message: 'could not acquire a connection' });
  }
  try {
    await client.query('BEGIN');
    for (const statement of statements.data) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    return err({ type: 'transient', code: 'runtime_grants_failed', message: String(e) });
  }

  try {
    for (const table of RUNTIME_TABLES) {
      const r = await client.query(
        `SELECT has_table_privilege($1, $2::regclass, 'INSERT') AS i,
                has_table_privilege($1, $2::regclass, 'SELECT') AS s,
                has_table_privilege($1, $2::regclass, 'UPDATE') AS u,
                has_table_privilege($1, $2::regclass, 'DELETE') AS d`,
        [opts.role, table],
      );
      const row = r.rows[0] as Record<string, boolean> | undefined;
      if (row === undefined || !row['i'] || !row['s'] || !row['u'] || !row['d']) {
        return err({
          type: 'integrity',
          code: 'runtime_grants_not_effective',
          message: `role ${opts.role} still cannot fully write ${table} after the GRANT. `
            + 'If the role inherits from a parent that is denied, or the table lives in a schema '
            + 'the role has no USAGE on, the grant statement succeeds and buys nothing.',
        });
      }
    }
    return ok(undefined);
  } catch (e) {
    return err({ type: 'integrity', code: 'runtime_grants_unverified', message: String(e) });
  } finally {
    client.release();
  }
}
