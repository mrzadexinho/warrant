// provision.ts: turns a Postgres that merely HAS the right roles into a ledger that is actually
// append-only, and refuses to say it succeeded on anything less.
//
// The service directory (pursuit `infra/.../services/warrant-ledger/`) creates the roles and the
// schemas and deliberately stops there: duplicating this SQL outside warrant would be a second
// source of truth for a security control. So between "the container is healthy" and "the ledger is
// append-only" there was a manual step with no entrypoint, and a healthy container looks exactly
// like a hardened one from the outside. That gap is what this closes.
//
// THREE CONNECTIONS ARE NOT AN ACCIDENT, and this is the whole design:
//
//   - the OWNER pool applies (CREATE TABLE, triggers, REVOKE, GRANT);
//   - the APP pool proves, because assertLedgerAppendOnly measures `current_user`, so running it on
//     the owner connection would prove nothing about the role the application actually uses;
//   - and the expected role name is checked against what the app credential ACTUALLY authenticated
//     as, because every posture check below passes just as happily for the wrong non-owner role. A
//     URL pointing at some third role would report a perfectly hardened ledger that the application
//     never touches.
//
// applyAppendOnlyGuards already verifies its own end state with has_table_privilege. Re-proving it
// through a second, differently-privileged connection is not redundancy for its own sake: the
// question this file has to answer is "can the credential in the application's environment rewrite
// history", and only a connection made with that credential can answer it.
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type pg from 'pg';
import { applyAppendOnlyGuards, DEFAULT_LEDGER_TABLE } from './append-only.js';
import { assertLedgerAppendOnly } from './assert-append-only.js';
import type { AppendOnlyProof } from './assert-append-only.js';
import { PostgresLedger } from './postgres.js';

export interface ProvisionOptions {
  /** The role the application will run as. Must not own the table. */
  readonly appRole: string;
  /** Defaults to DEFAULT_LEDGER_TABLE. */
  readonly table?: string;
}

/**
 * Idempotent. `ensureTable` is CREATE ... IF NOT EXISTS and the guard statements are all
 * CREATE OR REPLACE / DROP IF EXISTS / REVOKE / GRANT, so re-running on a hardened ledger with rows
 * in it changes nothing and re-proves the property. That matters more than it sounds: a step you are
 * afraid to re-run is a step nobody runs after an incident.
 */
export async function provisionLedger(
  owner: pg.Pool,
  app: pg.Pool,
  opts: ProvisionOptions,
): Promise<Result<AppendOnlyProof, WarrantError>> {
  const table = opts.table ?? DEFAULT_LEDGER_TABLE;

  try {
    await new PostgresLedger(owner).ensureTable();
  } catch (e) {
    return err({ type: 'transient', code: 'ensure_table_failed', message: String(e) });
  }

  const applied = await applyAppendOnlyGuards(owner, { role: opts.appRole, table });
  if (applied.error !== null) return err(applied.error);

  const proof = await assertLedgerAppendOnly(app, table);
  if (proof.error !== null) return err(proof.error);

  // The check assertLedgerAppendOnly cannot make, because it is deliberately ignorant of which role
  // it was supposed to be measuring. Everything above would pass for a credential pointing at any
  // other non-owner role, and would then be reported as a hardened ledger the application does not
  // use.
  if (proof.data.currentUser !== opts.appRole) {
    return err({
      type: 'integrity',
      code: 'app_role_mismatch',
      message:
        `the application credential authenticated as ${proof.data.currentUser}, not ${opts.appRole}. `
        + `The guards were applied to ${opts.appRole}, so this proof describes a role the application `
        + 'does not run as. Point the application URL at the role the guards were applied to.',
    });
  }

  return ok(proof.data);
}
