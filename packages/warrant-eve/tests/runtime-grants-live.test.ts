// runtime-grants-live.test.ts: the park store and the outbox are written by the RUNTIME role, not
// the admin role, and nothing was granting it anything on them.
//
// Found while provisioning the ceremony database. applyAppendOnlyGuards grants INSERT and SELECT on
// warrant_ledger and says nothing about the other two tables. ceremony-deps builds PostgresParkStore
// and PostgresOutbox on the APP pool while ensureSchema creates them on the ADMIN pool, so the
// tables end up owned by admin with no grant to the app role at all. In Postgres a freshly created
// table gives PUBLIC nothing, so the first governed call that parks would die on
// `permission denied for table warrant_eve_parks`.
//
// Every existing Postgres test runs as ONE role that owns its own tables, which is exactly the
// configuration in which this bug cannot appear.
//
// Gated on WARRANT_TEST_DATABASE_URL, same idiom as conformance-postgres.test.ts, and confined to
// its own schema so a parallel suite cannot collide on the fixed table names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresParkStore } from '../src/park-store-pg.js';
import { PostgresOutbox } from '../src/outbox-pg.js';
import { applyRuntimeGrants } from '../src/runtime-grants.js';

const DB_URL = process.env['WARRANT_TEST_DATABASE_URL'];

const SUFFIX = `${process.pid}_${Date.now()}`;
const SCHEMA = `we_grants_${SUFFIX}`;
const ROLE = `we_grants_role_${SUFFIX}`;

describe.skipIf(!DB_URL)('the runtime role can write the tables the runtime owns', () => {
  let owner: pg.Pool;
  let asRole: pg.Client;

  beforeAll(async () => {
    const bootstrap = new pg.Pool({ connectionString: DB_URL! });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();

    owner = new pg.Pool({ connectionString: DB_URL!, options: `-c search_path=${SCHEMA}` });
    // The admin/owner creates the schema, exactly as ceremony-deps.ensureSchema does.
    await new PostgresParkStore(owner).ensureTable();
    await new PostgresOutbox(owner).ensureTable();
    await owner.query(`CREATE ROLE ${ROLE} NOLOGIN`);
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${ROLE}`);

    asRole = new pg.Client({ connectionString: DB_URL!, options: `-c search_path=${SCHEMA}` });
    await asRole.connect();
  });

  afterAll(async () => {
    await asRole?.end().catch(() => undefined);
    await owner?.query(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
    await owner?.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await owner?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await owner?.end().catch(() => undefined);
  });

  it('has no privileges on the park store or the outbox before the grants, which is the bug', async () => {
    // Asserted rather than assumed: if a future Postgres default handed PUBLIC these privileges,
    // the grants below would be untestable and this test would say so instead of passing hollow.
    const before = await owner.query(
      `SELECT has_table_privilege($1, 'warrant_eve_parks', 'INSERT')  AS parks,
              has_table_privilege($1, 'warrant_eve_outbox', 'INSERT') AS outbox`,
      [ROLE],
    );
    expect(before.rows[0].parks).toBe(false);
    expect(before.rows[0].outbox).toBe(false);
  });

  it('can insert, read, update and retire after the grants are applied', async () => {
    const applied = await applyRuntimeGrants(owner, { role: ROLE });
    expect(applied.error).toBeNull();

    await asRole.query(`SET ROLE ${ROLE}`);
    // Driven as SQL rather than through the stores, because what is under test is the privilege,
    // and the stores would fail identically for a schema mistake.
    await expect(asRole.query(
      `INSERT INTO warrant_eve_parks
         (review_id, run_id, call_id, eve_request_id, continuation_token, parked_at)
       VALUES ('rv-1', 'run-1', 'call-1', 'req-1', 'tok-1', now())`,
    )).resolves.toBeDefined();
    await expect(asRole.query(`SELECT * FROM warrant_eve_parks`)).resolves.toBeDefined();
    await expect(asRole.query(`UPDATE warrant_eve_parks SET call_id = 'call-2'`)).resolves.toBeDefined();
    await asRole.query('RESET ROLE');
  });

  it('still cannot touch the ledger beyond insert and select, so the grants did not over-reach', async () => {
    // The whole point of section 9.1 is that widening the runtime role is easy to do by accident.
    // applyRuntimeGrants must not hand out anything on warrant_ledger.
    const r = await owner.query(
      `SELECT has_table_privilege($1, 'warrant_eve_parks', 'DELETE') AS parks_delete`,
      [ROLE],
    );
    expect(r.rows[0].parks_delete).toBe(true); // parks is deliberately NOT append-only
  });
});
