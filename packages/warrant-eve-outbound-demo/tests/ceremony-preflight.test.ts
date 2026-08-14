// Two groups. The drift group always runs and is the one that stops this probe from silently
// looking for triggers nobody creates. The Postgres group is the real proof and is env-gated like
// every other Postgres suite in this repo.
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { appendOnlySql, applyAppendOnlyGuards } from '@idriszade/warrant-ledger';
import { assertLedgerAppendOnly } from '../src/ceremony-preflight.js';

describe('append-only trigger names: the probe and the DDL must agree', () => {
  // Without this, assertLedgerAppendOnly would report ledger_row_trigger_missing on a correctly
  // hardened table, indistinguishable from a table nobody hardened. Fail-closed but useless.
  it('the names the probe looks for are the names appendOnlySql creates', () => {
    const sql = appendOnlySql({ role: 'warrant_app' }).data!.join('\n');
    expect(sql).toContain('warrant_ledger_append_only_row');
    expect(sql).toContain('warrant_ledger_append_only_truncate');
  });

  it('rejects a table name that is not a plain identifier before touching a connection', async () => {
    const r = await assertLedgerAppendOnly(null as unknown as pg.Pool, 'x"; DROP TABLE warrant_ledger; --');
    expect(r.error?.code).toBe('invalid_identifier');
  });
});

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];
const suite = DB_URL ? describe : describe.skip;

// Unique per run so a parallel suite cannot collide, and so the shared warrant_ledger table other
// Postgres suites use is never hardened out from under them.
const SUFFIX = `${process.pid}_${Date.now()}`;
const TABLE = `wl_probe_${SUFFIX}`;
const ROLE = `wl_probe_role_${SUFFIX}`;

suite('assertLedgerAppendOnly against a real database', () => {
  const admin = new pg.Pool({ connectionString: DB_URL });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => undefined);
    await admin.query(`DROP FUNCTION IF EXISTS ${TABLE}_append_only() CASCADE`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  async function asRole<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      // SET ROLE to a non-superuser drops superuser status for privilege checks, so has_table_privilege
      // below answers about the app role rather than about the connecting superuser.
      await client.query(`SET ROLE ${ROLE}`);
      return await fn(client);
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  }

  it('reports the app role as owner-free, insert-only and both-triggers-enabled once hardened', async () => {
    await admin.query(`CREATE TABLE ${TABLE} (seq BIGINT PRIMARY KEY, run_id TEXT NOT NULL)`);
    await admin.query(`DO $$ BEGIN CREATE ROLE ${ROLE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

    // GRANT ALL FIRST, deliberately. A freshly created role holds no privileges on a new table, so
    // without this the assertions below would report canUpdate:false whether or not the REVOKE ever
    // ran, and deleting the REVOKE statement from appendOnlySql would leave this test green. The
    // grant is what makes the revoke observable.
    await admin.query(`GRANT ALL PRIVILEGES ON ${TABLE} TO ${ROLE}`);
    const before = await asRole(async (c) =>
      c.query(`SELECT has_table_privilege(current_user, '${TABLE}', 'UPDATE') AS u`));
    expect((before.rows[0] as { u: boolean }).u).toBe(true);

    const applied = await applyAppendOnlyGuards(admin, { role: ROLE, table: TABLE });
    expect(applied.error).toBeNull();

    const proof = await asRole(async (client) => {
      // A PoolClient satisfies the .query surface assertLedgerAppendOnly uses, and using the SAME
      // connection is what makes current_user the role rather than the superuser.
      return assertLedgerAppendOnly(client as unknown as pg.Pool, TABLE);
    });

    expect(proof.error).toBeNull();
    expect(proof.data).toMatchObject({
      table: TABLE, currentUser: ROLE,
      canInsert: true, canSelect: true,
      canUpdate: false, canDelete: false, canTruncate: false,
      rowTriggerEnabled: true, truncateTriggerEnabled: true,
    });
    expect(proof.data!.owner).not.toBe(ROLE);
  });

  it('refuses a table the probing role owns, whatever the triggers say', async () => {
    // warrant_ledger's real owner in the test database is the connecting superuser, so probing it
    // as the superuser is exactly the mis-provisioned deployment shape section 9.1 warns about.
    const owned = `wl_owned_${SUFFIX}`;
    await admin.query(`CREATE TABLE ${owned} (seq BIGINT PRIMARY KEY, run_id TEXT NOT NULL)`);
    try {
      const r = await assertLedgerAppendOnly(admin, owned);
      expect(r.error?.code).toBe('ledger_role_owns_table');
    } finally {
      await admin.query(`DROP TABLE IF EXISTS ${owned}`).catch(() => undefined);
    }
  });

  it('refuses a table that does not exist rather than reporting it hardened', async () => {
    const r = await assertLedgerAppendOnly(admin, `wl_absent_${SUFFIX}`);
    expect(r.error).not.toBeNull();
    // regclass raises 42P01 inside the query, so this surfaces as a probe failure, not a pass.
    expect(['ledger_table_missing', 'ledger_probe_failed']).toContain(r.error!.code);
  });
});
