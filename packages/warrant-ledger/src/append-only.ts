// Append-only database guards for the ledger table (spec 9.1).
//
// WHY THIS EXISTS: entryHash is an UNKEYED SHA-256 over the entry body (src/entry.ts), so anyone
// who can UPDATE or DELETE rows can recompute the entire chain and leave it internally consistent.
// verifyChain would still pass over the rewritten history. The tamper-EVIDENCE property holds
// against someone WITHOUT table write access; it does not hold against the database credential
// itself. These statements are what make the application credential unable to rewrite the ledger.
//
// HONESTY, and this is a real limit rather than a caveat: neither the trigger nor the REVOKE binds
// the table OWNER or a superuser. An owner can DROP TRIGGER or ALTER TABLE ... DISABLE TRIGGER, and
// a superuser bypasses every GRANT. The property is only real when the application role is NOT the
// owner of the table. The tests also assert the trigger fires for the owner; that is defence in
// depth against a mis-provisioned deployment, not a security proof.
//
// SECOND ESCAPE, found in the adversarial pass and closed here: `REVOKE ... FROM <role>` removes
// only privileges granted DIRECTLY to that role. A role that holds UPDATE via PUBLIC, or inherits
// it from a parent role, keeps it and this function used to report ok anyway. The statement list
// now revokes from PUBLIC as well, and applyAppendOnlyGuards VERIFIES the end state with
// has_table_privilege (which does account for PUBLIC and for inherited membership) instead of
// assuming the statements achieved it. Inherited-from-a-parent-role is still not revocable from
// here, which is exactly why the verification exists: it fails rather than claiming success.
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type pg from 'pg';
import type { WarrantError } from '@idriszade/warrant-core';

/** The table PostgresLedger.ensureTable creates. */
export const DEFAULT_LEDGER_TABLE = 'warrant_ledger';

// GRANT and CREATE TRIGGER accept no bind parameters, so role and table are interpolated into the
// SQL text. This regex is therefore the ONLY thing standing between a caller-supplied name and the
// statement string, which is why appendOnlySql (not applyAppendOnlyGuards) does the validating:
// the rejection stays testable with no database in reach.
//
// '$' is deliberately NOT allowed even though Postgres permits it in identifiers. The function body
// below is dollar-quoted with $warrant_ao$, and a table named `a$warrant_ao$b` closes that quote
// early and turns the rest of the template into live SQL. Today the surviving charset cannot carry
// a useful payload, but "the emitted SQL is attacker-influenced and only accidentally harmless" is
// not a property worth relying on.
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Postgres truncates identifiers at NAMEDATALEN-1 = 63 bytes, SILENTLY. The longest name derived
// below is `${table}_append_only_truncate`, 21 characters past the table name. At 51+ characters
// `${fn}_row` and `${fn}_truncate` truncate to the SAME 63 bytes, so statement 4's
// DROP TRIGGER IF EXISTS removes the row trigger statement 3 just created, UPDATE and DELETE end up
// unguarded, and the whole thing still reports ok. Bounding the input is the only cheap fix.
const MAX_TABLE_LEN = 63 - '_append_only_truncate'.length;
const MAX_ROLE_LEN = 63;

export interface AppendOnlyOptions {
  /** Application role that must end up holding INSERT and SELECT and nothing else. */
  role: string;
  /** Defaults to DEFAULT_LEDGER_TABLE. */
  table?: string;
}

function invalidIdentifier(what: string, value: string, why: string): WarrantError {
  return {
    type: 'validation',
    code: 'invalid_identifier',
    message: `Invalid SQL identifier for ${what} (${why}): ${JSON.stringify(value)}`,
  };
}

function checkIdentifier(what: string, value: string, max: number): WarrantError | null {
  if (!SQL_IDENTIFIER.test(value)) return invalidIdentifier(what, value, 'shape');
  if (value.length > max) {
    return invalidIdentifier(what, value, `longer than ${max} characters, Postgres would truncate it`);
  }
  return null;
}

/**
 * The ordered statement list. Pure: no connection, no clock, no environment.
 * Returns err (never a partial list) when either identifier is unsafe to interpolate.
 */
export function appendOnlySql(opts: AppendOnlyOptions): Result<string[], WarrantError> {
  const table = opts.table ?? DEFAULT_LEDGER_TABLE;
  const badRole = checkIdentifier('role', opts.role, MAX_ROLE_LEN);
  if (badRole) return err(badRole);
  const badTable = checkIdentifier('table', table, MAX_TABLE_LEN);
  if (badTable) return err(badTable);

  const fn = `${table}_append_only`;
  const rowTrigger = `${fn}_row`;
  const truncateTrigger = `${fn}_truncate`;

  return ok([
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $warrant_ao$
BEGIN
  RAISE EXCEPTION '${table} is append-only: % is not permitted', TG_OP USING ERRCODE = '42501';
END;
$warrant_ao$`,
    `DROP TRIGGER IF EXISTS ${rowTrigger} ON ${table}`,
    `CREATE TRIGGER ${rowTrigger} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    `DROP TRIGGER IF EXISTS ${truncateTrigger} ON ${table}`,
    // A FOR EACH ROW trigger cannot see TRUNCATE at all, and REVOKE TRUNCATE does not bind the
    // table owner. Omitting this statement-level trigger is the gap most deployments leave open.
    `CREATE TRIGGER ${truncateTrigger} BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`,
    // PUBLIC first. A privilege held via PUBLIC survives a REVOKE aimed at the role by name, and
    // that gap is invisible to any test whose fixture grants the role its privileges directly.
    `REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM PUBLIC`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${opts.role}`,
    `GRANT INSERT, SELECT ON ${table} TO ${opts.role}`,
  ]);
}

const VERIFY_SQL = `
  SELECT has_table_privilege($1, $2::regclass, 'INSERT')   AS can_insert,
         has_table_privilege($1, $2::regclass, 'SELECT')   AS can_select,
         has_table_privilege($1, $2::regclass, 'UPDATE')   AS can_update,
         has_table_privilege($1, $2::regclass, 'DELETE')   AS can_delete,
         has_table_privilege($1, $2::regclass, 'TRUNCATE') AS can_truncate`;

/**
 * Runs the statements in one transaction, then VERIFIES the end state before returning ok.
 *
 * Both halves are load-bearing. Without the transaction, a failure at the REVOKE leaves the triggers
 * installed and the grants untouched, and the caller cannot tell that from "nothing applied"
 * (Postgres DDL is transactional, so this costs one client checkout). Without the verification, ok
 * means "the statements ran", which is a weaker claim than the one the caller acts on: a role that
 * inherits UPDATE from a parent role still holds it after every statement above succeeds.
 */
export async function applyAppendOnlyGuards(
  pool: pg.Pool,
  opts: AppendOnlyOptions,
): Promise<Result<void, WarrantError>> {
  const statements = appendOnlySql(opts);
  // Fail before the connection is touched, and preserve invalid_identifier rather than letting the
  // server decide what to call it. Without this the null data would fall into the loop below and
  // the caller would be handed append_only_apply_failed for a caller-side validation defect.
  if (statements.error !== null) return err(statements.error);

  const table = opts.table ?? DEFAULT_LEDGER_TABLE;
  const client = await pool.connect().catch(() => null);
  if (client === null) {
    return err({ type: 'transient', code: 'append_only_apply_failed', message: 'could not acquire a connection' });
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
    return err({ type: 'transient', code: 'append_only_apply_failed', message: String(e) });
  }

  try {
    const r = await client.query(VERIFY_SQL, [opts.role, table]);
    const row = r.rows[0] as Record<string, boolean> | undefined;
    if (row === undefined) {
      return err({ type: 'integrity', code: 'append_only_unverified', message: `could not read privileges on ${table}` });
    }
    const residual = (['update', 'delete', 'truncate'] as const).filter((v) => row[`can_${v}`] === true);
    if (residual.length > 0) {
      return err({
        type: 'integrity',
        code: 'append_only_not_enforced',
        message: `role ${opts.role} still holds ${residual.join(', ').toUpperCase()} on ${table} after the REVOKE, `
          + 'which means the privilege is inherited from a parent role rather than granted directly. '
          + 'Revoke it on the parent, or give the application a role that inherits nothing.',
      });
    }
    if (row['can_insert'] !== true || row['can_select'] !== true) {
      return err({
        type: 'integrity',
        code: 'append_only_not_enforced',
        message: `role ${opts.role} cannot INSERT or SELECT on ${table} after the GRANT`,
      });
    }
    return ok(undefined);
  } catch (e) {
    // Unverified is NOT ok. The caller deploys on the strength of this return value.
    return err({ type: 'integrity', code: 'append_only_unverified', message: String(e) });
  } finally {
    client.release();
  }
}
