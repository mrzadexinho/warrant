// assert-append-only.ts: proves, against a live deployment, that the append-only property actually
// holds for the role connected to this pool.
//
// It has two consumers: the ceremony and `provisionLedger`, which is the threshold for a
// capability living in a shared package rather than being duplicated.
// The stronger reason is placement: the function that INSTALLS the property (applyAppendOnlyGuards)
// and the function that PROVES it belong in the same package, so a change to the trigger names
// cannot land in one without the other being in front of the same reader. warrant-ledger cannot
// import the demo package anyway (the demo already depends on this one), so the alternative was a
// second copy of the proof, and a second source of truth for a security control is the same mistake
// as a second guard.
//
// It is a CATALOG read, not a mutation: has_table_privilege is authoritative about inherited and
// PUBLIC grants, pg_trigger says whether the triggers are enabled, and pg_class.relowner answers the
// question that actually decides whether any of it binds. Neither a trigger nor a REVOKE constrains
// the table OWNER, who can DROP TRIGGER or ALTER TABLE ... DISABLE TRIGGER, so an app role that owns
// its own audit table has no append-only property at all, however many triggers sit on it. That
// check is the load-bearing one here.
//
// It reads privileges for `current_user`, so WHICH pool it is handed is part of the claim: run it on
// the owner connection and it proves nothing about the application. Callers that care which role was
// measured must check `proof.currentUser` themselves: this function deliberately does not know
// which role it is supposed to be looking at.
import type pg from 'pg';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface AppendOnlyProof {
  table: string;
  currentUser: string;
  owner: string;
  canInsert: boolean;
  canSelect: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canTruncate: boolean;
  rowTriggerEnabled: boolean;
  truncateTriggerEnabled: boolean;
}

const PRIV_SQL = `
  SELECT current_user                                            AS current_user,
         pg_get_userbyid(c.relowner)                             AS owner,
         has_table_privilege(current_user, c.oid, 'INSERT')      AS can_insert,
         has_table_privilege(current_user, c.oid, 'SELECT')      AS can_select,
         has_table_privilege(current_user, c.oid, 'UPDATE')      AS can_update,
         has_table_privilege(current_user, c.oid, 'DELETE')      AS can_delete,
         has_table_privilege(current_user, c.oid, 'TRUNCATE')    AS can_truncate
    FROM pg_class c
   WHERE c.oid = $1::regclass`;

const TRIGGER_SQL = `
  SELECT tgname, tgenabled
    FROM pg_trigger
   WHERE tgrelid = $1::regclass AND NOT tgisinternal`;

/**
 * Proves the connected role genuinely cannot rewrite the ledger. Returns err on the FIRST property
 * that does not hold, naming it, because a partially hardened ledger is not a weaker guarantee, it
 * is no guarantee: an attacker only needs one of UPDATE, DELETE or TRUNCATE.
 */
export async function assertLedgerAppendOnly(
  pool: pg.Pool,
  table = 'warrant_ledger',
): Promise<Result<AppendOnlyProof, WarrantError>> {
  if (!IDENT.test(table)) {
    return err({ type: 'validation', code: 'invalid_identifier', message: `not a plain identifier: ${table}` });
  }

  let proof: AppendOnlyProof;
  try {
    const r = await pool.query(PRIV_SQL, [table]);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      return err({ type: 'integrity', code: 'ledger_table_missing', message: `no such table: ${table}` });
    }
    const t = await pool.query(TRIGGER_SQL, [table]);
    const triggers = new Map(
      (t.rows as { tgname: string; tgenabled: string }[]).map((x) => [x.tgname, x.tgenabled]),
    );
    proof = {
      table,
      currentUser: String(row['current_user']),
      owner: String(row['owner']),
      canInsert: row['can_insert'] === true,
      canSelect: row['can_select'] === true,
      canUpdate: row['can_update'] === true,
      canDelete: row['can_delete'] === true,
      canTruncate: row['can_truncate'] === true,
      // 'D' means disabled; 'O', 'R' and 'A' are all enabled states. The names are derived the same
      // way appendOnlySql derives them, from the table name, and the drift test asserts these two
      // strings appear in the generated SQL: a probe looking for a trigger name nobody creates would
      // report "missing" forever, which is fail-closed but useless, and would look identical to a
      // genuinely unhardened table.
      rowTriggerEnabled: (triggers.get(`${table}_append_only_row`) ?? 'D') !== 'D',
      truncateTriggerEnabled: (triggers.get(`${table}_append_only_truncate`) ?? 'D') !== 'D',
    };
  } catch (e) {
    return err({ type: 'transient', code: 'ledger_probe_failed', message: String(e) });
  }

  const fail = (code: string, message: string): Result<AppendOnlyProof, WarrantError> =>
    err({ type: 'integrity', code, message });

  if (proof.currentUser === proof.owner) {
    return fail(
      'ledger_role_owns_table',
      `the runtime role ${proof.currentUser} OWNS ${table}; an owner can DROP TRIGGER and is not `
        + 'bound by REVOKE, so the append-only property does not hold. Provision a non-owner app role.',
    );
  }
  if (!proof.canInsert || !proof.canSelect) {
    return fail('ledger_role_cannot_append', `role ${proof.currentUser} lacks INSERT or SELECT on ${table}`);
  }
  if (proof.canUpdate) return fail('ledger_role_can_update', `role ${proof.currentUser} still holds UPDATE on ${table}`);
  if (proof.canDelete) return fail('ledger_role_can_delete', `role ${proof.currentUser} still holds DELETE on ${table}`);
  if (proof.canTruncate) return fail('ledger_role_can_truncate', `role ${proof.currentUser} still holds TRUNCATE on ${table}`);
  if (!proof.rowTriggerEnabled) return fail('ledger_row_trigger_missing', `${table}_append_only_row is absent or disabled`);
  if (!proof.truncateTriggerEnabled) {
    return fail('ledger_truncate_trigger_missing', `${table}_append_only_truncate is absent or disabled`);
  }

  return ok(proof);
}
