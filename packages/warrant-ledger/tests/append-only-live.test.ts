// append-only-live.test.ts: the REAL proof of spec 9.1, gated on WARRANT_TEST_DATABASE_URL exactly
// like conformance-postgres.test.ts. It provisions a non-owner role, applies the guards, and
// asserts INSERT/SELECT work while UPDATE/DELETE/TRUNCATE all fail. The pure statement-shape group
// lives in append-only.test.ts; split because one file crossed the 400-line test limit.
//
// See src/append-only.ts for why the owner-side assertions are defence in depth only: an owner can
// DROP TRIGGER and is not bound by REVOKE, so they prove a mis-provisioned deployment still trips
// the trigger, not that the property holds against the owner.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applyAppendOnlyGuards } from '../src/append-only.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

// ---------------------------------------------------------------------------
// Group 2: the real proof. Skips without a database, same idiom as
// conformance-postgres.test.ts. Uses a uniquely named table and role per run so
// a parallel suite cannot collide, and drops both in afterAll even on failure.
// ---------------------------------------------------------------------------
const SUFFIX = `${process.pid}_${Date.now()}`;
const TABLE = `wl_ao_${SUFFIX}`;
const ROLE = `wl_ao_role_${SUFFIX}`;

interface PgError { code?: string; message: string }
async function expectFail(client: pg.Client, sql: string): Promise<PgError> {
  try {
    await client.query(sql);
  } catch (e) {
    return e as PgError;
  }
  throw new Error(`expected failure, but this succeeded: ${sql}`);
}

describe.skipIf(!DB_URL)('append-only guards against a live table', () => {
  let owner: pg.Pool;
  let asRole: pg.Client;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: DB_URL! });
    await owner.query(`CREATE TABLE ${TABLE} (seq BIGINT PRIMARY KEY, note TEXT NOT NULL)`);
    await owner.query(`CREATE ROLE ${ROLE} NOLOGIN`);
    await owner.query(`INSERT INTO ${TABLE} (seq, note) VALUES (1, 'genesis')`);
    // Pre-grant EXACTLY the three verbs the guards must take away, and nothing else. A role that
    // never held UPDATE would fail the refusal assertions whether or not the REVOKE existed, so
    // this is what makes the REVOKE load-bearing. Granting ALL here instead would have masked the
    // GRANT INSERT, SELECT statement in the same way: measured, both are now individually visible.
    // It is also the realistic shape of a deployment being hardened after the fact.
    await owner.query(`GRANT UPDATE, DELETE, TRUNCATE ON ${TABLE} TO ${ROLE}`);
    const applied = await applyAppendOnlyGuards(owner, { role: ROLE, table: TABLE });
    expect(applied.error).toBeNull();
    asRole = new pg.Client({ connectionString: DB_URL! });
    await asRole.connect();
    await asRole.query(`SET ROLE ${ROLE}`);
  });

  afterAll(async () => {
    // Cleanup runs even when a test above failed: a leaked role blocks the next run entirely.
    if (asRole) { try { await asRole.end(); } catch { /* already closed */ } }
    if (owner) {
      try { await owner.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`); } catch { /* best effort */ }
      try { await owner.query(`DROP FUNCTION IF EXISTS ${TABLE}_append_only() CASCADE`); } catch { /* best effort */ }
      try { await owner.query(`DROP ROLE IF EXISTS ${ROLE}`); } catch { /* best effort */ }
      await owner.end();
    }
  });

  it('the application role can INSERT', async () => {
    await asRole.query(`INSERT INTO ${TABLE} (seq, note) VALUES (2, 'appended')`);
    const r = await asRole.query(`SELECT note FROM ${TABLE} WHERE seq = 2`);
    expect(r.rows[0]).toEqual({ note: 'appended' });
  });

  it('the application role can SELECT', async () => {
    const r = await asRole.query(`SELECT seq FROM ${TABLE} WHERE seq = 1`);
    expect(r.rowCount).toBe(1);
  });

  // Each of these asserts a PERMISSION denial, not merely a 42501. The triggers raise 42501 too,
  // so `expect(e.code).toBe('42501')` alone cannot tell the REVOKE apart from the trigger catching
  // the statement one layer later, and deleting the REVOKE would leave it green.
  it('the application role cannot UPDATE', async () => {
    const e = await expectFail(asRole, `UPDATE ${TABLE} SET note = 'rewritten' WHERE seq = 1`);
    expect(e.code).toBe('42501');
    expect(e.message).toContain('permission denied');
    expect(e.message).not.toContain('append-only');
  });

  it('the application role cannot DELETE', async () => {
    const e = await expectFail(asRole, `DELETE FROM ${TABLE} WHERE seq = 1`);
    expect(e.code).toBe('42501');
    expect(e.message).toContain('permission denied');
    expect(e.message).not.toContain('append-only');
  });

  it('the application role cannot TRUNCATE', async () => {
    const e = await expectFail(asRole, `TRUNCATE ${TABLE}`);
    expect(e.code).toBe('42501');
    expect(e.message).toContain('permission denied');
    expect(e.message).not.toContain('append-only');
  });

  // Self-contained on purpose. This used to read the row back through the ROLE connection after
  // relying on the UPDATE/DELETE cases above having already run, so it was order-coupled and a
  // mutation that merely removed the role's SELECT grant turned it red for a reason that had
  // nothing to do with tampering. It now issues its own refused writes and reads the result back
  // through the OWNER connection, so nothing about the role's privileges can produce its failure.
  it('leaves the genesis row untouched after a refused UPDATE and DELETE', async () => {
    await expectFail(asRole, `UPDATE ${TABLE} SET note = 'tampered' WHERE seq = 1`);
    await expectFail(asRole, `DELETE FROM ${TABLE} WHERE seq = 1`);
    const r = await owner.query(`SELECT note FROM ${TABLE} WHERE seq = 1`);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toEqual({ note: 'genesis' });
  });

  // The PUBLIC escape, as a live regression. `REVOKE ... FROM <role>` removes only privileges
  // granted directly to that role; a privilege held via PUBLIC survives it untouched, and the
  // fixture above cannot see that because it grants the role its verbs by name. Before the PUBLIC
  // revoke landed, applyAppendOnlyGuards returned ok here and the role could still UPDATE.
  it('takes away a privilege the role holds via PUBLIC, not just one granted to it directly', async () => {
    const table = `${TABLE}_pub`;
    const role = `${ROLE}_pub`;
    let client: pg.Client | undefined;
    try {
      await owner.query(`CREATE TABLE ${table} (seq BIGINT PRIMARY KEY, note TEXT NOT NULL)`);
      await owner.query(`CREATE ROLE ${role} NOLOGIN`);
      await owner.query(`INSERT INTO ${table} (seq, note) VALUES (1, 'genesis')`);
      // Granted to PUBLIC and NEVER to the role: the role inherits it, and a REVOKE naming the
      // role removes nothing at all.
      await owner.query(`GRANT UPDATE, DELETE, TRUNCATE ON ${table} TO PUBLIC`);

      const applied = await applyAppendOnlyGuards(owner, { role, table });
      expect(applied.error).toBeNull();

      client = new pg.Client({ connectionString: DB_URL! });
      await client.connect();
      await client.query(`SET ROLE ${role}`);
      const e = await expectFail(client, `UPDATE ${table} SET note = 'rewritten' WHERE seq = 1`);
      expect(e.code).toBe('42501');
      expect(e.message).toContain('permission denied');
      // Still an append-only ledger for its legitimate use.
      await client.query(`INSERT INTO ${table} (seq, note) VALUES (2, 'appended')`);
    } finally {
      if (client) { try { await client.end(); } catch { /* already closed */ } }
      try { await owner.query(`DROP TABLE IF EXISTS ${table} CASCADE`); } catch { /* best effort */ }
      try { await owner.query(`DROP FUNCTION IF EXISTS ${table}_append_only() CASCADE`); } catch { /* best effort */ }
      try { await owner.query(`DROP ROLE IF EXISTS ${role}`); } catch { /* best effort */ }
    }
  });

  // Defence in depth against a mis-provisioned deployment, NOT a security proof: the owner can
  // DROP TRIGGER or ALTER TABLE ... DISABLE TRIGGER and then do all three freely.
  it.each(['UPDATE', 'DELETE', 'TRUNCATE'])('the trigger also fires for the owner on %s', async (op) => {
    const sql = op === 'UPDATE'
      ? `UPDATE ${TABLE} SET note = 'owner' WHERE seq = 1`
      : op === 'DELETE' ? `DELETE FROM ${TABLE} WHERE seq = 1` : `TRUNCATE ${TABLE}`;
    const client = await owner.connect();
    try {
      const e = await expectFail(client as unknown as pg.Client, sql);
      expect(e.code).toBe('42501');
      // Names TG_OP, which is what distinguishes the trigger from a bare permission denial.
      expect(e.message).toContain(op);
      expect(e.message).toContain('append-only');
    } finally {
      client.release();
    }
  });
});
