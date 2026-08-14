// append-only.test.ts: the pure half. appendOnlySql is the validation seam, so the identifier
// rejection and the statement shape are testable with no database in reach, and
// applyAppendOnlyGuards is driven through a stubbed pool. The live Postgres proof is
// append-only-live.test.ts; split because one file crossed the 400-line test limit.
import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { appendOnlySql, applyAppendOnlyGuards, DEFAULT_LEDGER_TABLE } from '../src/append-only.js';

const INJECTION = 'x"; DROP TABLE warrant_ledger; --';

// applyAppendOnlyGuards checks out ONE client (the statements run in a transaction) and then reads
// the privileges back, so the stub answers both. The default verification row is the hardened end
// state; a test that wants the unhardened one overrides `verify`.
const HARDENED = { can_insert: true, can_select: true, can_update: false, can_delete: false, can_truncate: false };

function stubPool(
  impl?: (sql: string) => Promise<unknown>,
  verify: Record<string, boolean> | null = HARDENED,
): { pool: pg.Pool; calls: string[]; released: () => number } {
  const calls: string[] = [];
  let releases = 0;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    // impl FIRST, so a test can make the verification query itself fail. Checking the
    // has_table_privilege branch first would make that test silently unreachable and green.
    if (impl) return impl(sql);
    if (sql.includes('has_table_privilege')) return { rows: verify === null ? [] : [verify] };
    return { rows: [] };
  });
  const client = { query, release: () => { releases += 1; } };
  return {
    pool: { query, connect: async () => client } as unknown as pg.Pool,
    calls,
    released: () => releases,
  };
}

describe('appendOnlySql (no database)', () => {
  const sql = () => {
    const r = appendOnlySql({ role: 'app_role', table: 'scratch_tbl' });
    expect(r.error).toBeNull();
    return r.data!;
  };

  it('emits the eight contract statements in order', () => {
    const s = sql();
    expect(s).toHaveLength(8);
    expect(s[0]).toMatch(/^CREATE OR REPLACE FUNCTION scratch_tbl_append_only\(\)/);
    expect(s[1]).toMatch(/^DROP TRIGGER IF EXISTS /);
    expect(s[2]).toMatch(/^CREATE TRIGGER /);
    expect(s[3]).toMatch(/^DROP TRIGGER IF EXISTS /);
    expect(s[4]).toMatch(/^CREATE TRIGGER /);
    expect(s[5]).toMatch(/^REVOKE UPDATE, DELETE, TRUNCATE ON scratch_tbl FROM PUBLIC$/);
    expect(s[6]).toMatch(/^REVOKE UPDATE, DELETE, TRUNCATE ON scratch_tbl FROM app_role$/);
    expect(s[7]).toMatch(/^GRANT INSERT, SELECT ON scratch_tbl TO app_role$/);
  });

  // Its own case: REVOKE aimed at a role by name does not remove a privilege the role holds via
  // PUBLIC, and no fixture that grants the role its privileges directly can see the difference.
  it('revokes from PUBLIC as well as from the role, and PUBLIC first', () => {
    const s = sql();
    const pub = s.findIndex((x) => x.includes('FROM PUBLIC'));
    const role = s.findIndex((x) => x.endsWith('FROM app_role'));
    expect(pub).toBeGreaterThan(-1);
    expect(pub).toBeLessThan(role);
  });

  it('names the table in every statement', () => {
    for (const statement of sql()) expect(statement).toContain('scratch_tbl');
  });

  it('defaults the table to warrant_ledger', () => {
    const r = appendOnlySql({ role: 'app_role' });
    expect(r.error).toBeNull();
    expect(DEFAULT_LEDGER_TABLE).toBe('warrant_ledger');
    for (const statement of r.data!) expect(statement).toContain('warrant_ledger');
  });

  it('raises with ERRCODE 42501 and names TG_OP', () => {
    const fn = sql()[0]!;
    expect(fn).toContain('RAISE EXCEPTION');
    expect(fn).toContain("ERRCODE = '42501'");
    expect(fn).toContain('TG_OP');
    expect(fn).toContain('LANGUAGE plpgsql');
  });

  it('installs a BEFORE UPDATE OR DELETE row trigger', () => {
    const create = sql()[2]!;
    expect(create).toContain('BEFORE UPDATE OR DELETE ON scratch_tbl');
    expect(create).toContain('FOR EACH ROW');
    expect(create).toContain('EXECUTE FUNCTION scratch_tbl_append_only()');
    expect(sql()[1]).toContain('DROP TRIGGER IF EXISTS scratch_tbl_append_only_row ON scratch_tbl');
  });

  // Its own case on purpose: a FOR EACH ROW trigger cannot see TRUNCATE and REVOKE TRUNCATE does
  // not bind the owner, so this statement trigger is the guard most likely to be quietly dropped.
  it('installs a BEFORE TRUNCATE statement trigger, by name', () => {
    const s = sql();
    expect(s[3]).toContain('DROP TRIGGER IF EXISTS scratch_tbl_append_only_truncate ON scratch_tbl');
    expect(s[4]).toContain('CREATE TRIGGER scratch_tbl_append_only_truncate');
    expect(s[4]).toContain('BEFORE TRUNCATE ON scratch_tbl');
    expect(s[4]).toContain('FOR EACH STATEMENT');
    expect(s[4]).not.toContain('FOR EACH ROW');
  });

  it.each([
    ['role', INJECTION],
    ['role', ''],
    ['role', 'app role'],
    ['role', '1bad'],
  ])('rejects an invalid %s and returns no statements: %j', (_what, value) => {
    const r = appendOnlySql({ role: value, table: 'scratch_tbl' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('invalid_identifier');
    expect(r.error?.type).toBe('validation');
  });

  it.each([
    [INJECTION],
    [''],
    ['scratch tbl'],
  ])('rejects an invalid table and returns no statements: %j', (value) => {
    const r = appendOnlySql({ role: 'app_role', table: value });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('invalid_identifier');
    expect(r.error?.type).toBe('validation');
  });

  it('accepts the identifier characters the regex allows', () => {
    const r = appendOnlySql({ role: '_app1', table: 'T_b2' });
    expect(r.error).toBeNull();
    expect(r.data![7]).toContain('_app1');
  });

  // '$' is legal in a Postgres identifier and is rejected anyway. The function body is dollar-quoted
  // with $warrant_ao$, so a table named a$warrant_ao$b closes that quote early and the remainder of
  // the template becomes live SQL. It happens to fail closed today only because the surviving
  // charset cannot carry a payload, which is not a property to depend on.
  it.each([['table', 'a$warrant_ao$b'], ['table', 'tbl$1'], ['role', 'app$1']])
    ('rejects %s %j because it can break the dollar quote', (what, value) => {
      const r = what === 'table'
        ? appendOnlySql({ role: 'app_role', table: value })
        : appendOnlySql({ role: value, table: 'scratch_tbl' });
      expect(r.data).toBeNull();
      expect(r.error?.code).toBe('invalid_identifier');
    });

  // Postgres truncates identifiers at 63 bytes SILENTLY. At 51+ characters `${t}_append_only_row`
  // and `${t}_append_only_truncate` collide, so the fourth statement's DROP TRIGGER IF EXISTS
  // removes the row trigger the third just created and UPDATE/DELETE end up entirely unguarded.
  it('rejects a table name long enough for the two trigger names to collide', () => {
    const shortest = 'a'.repeat(43);
    const longest = 'a'.repeat(42);
    expect(appendOnlySql({ role: 'app_role', table: shortest }).error?.code).toBe('invalid_identifier');
    expect(appendOnlySql({ role: 'app_role', table: shortest }).error?.message).toContain('truncate');
    expect(appendOnlySql({ role: 'app_role', table: longest }).error).toBeNull();
  });

  it('the two trigger names never collide for any accepted table name', () => {
    const t = 'a'.repeat(42);
    const s = appendOnlySql({ role: 'app_role', table: t }).data!;
    const names = [...s.join('\n').matchAll(/TRIGGER (?:IF EXISTS )?(\w+)/g)].map((m) => m[1]!.slice(0, 63));
    expect(new Set(names).size).toBe(2);
  });

  it('rejects a role name Postgres would truncate', () => {
    expect(appendOnlySql({ role: 'r'.repeat(64), table: 'scratch_tbl' }).error?.code)
      .toBe('invalid_identifier');
  });
});

describe('applyAppendOnlyGuards (stubbed pool)', () => {
  it('runs every statement in order, inside one transaction, and returns ok', async () => {
    const { pool, calls, released } = stubPool();
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.error).toBeNull();
    const ddl = appendOnlySql({ role: 'app_role', table: 'scratch_tbl' }).data!;
    // Without BEGIN/COMMIT a failure at the REVOKE leaves the triggers installed and the grants
    // untouched, and the caller cannot distinguish that from nothing having been applied.
    expect(calls.slice(0, ddl.length + 2)).toEqual(['BEGIN', ...ddl, 'COMMIT']);
    expect(calls.some((c) => c.includes('has_table_privilege'))).toBe(true);
    expect(released()).toBe(1);
  });

  // ok used to mean "the statements ran". The caller acts on a stronger claim than that, so the
  // end state is read back: a role that inherits UPDATE from a parent role still holds it after
  // every statement above succeeds, and no REVOKE issued here can take it away.
  it('refuses to report ok when the role still holds UPDATE afterwards', async () => {
    const { pool } = stubPool(undefined, { ...HARDENED, can_update: true });
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('append_only_not_enforced');
    expect(r.error?.type).toBe('integrity');
    expect(r.error?.message).toContain('UPDATE');
  });

  it.each([['can_delete', 'DELETE'], ['can_truncate', 'TRUNCATE']])
    ('refuses to report ok when the role still holds %s afterwards', async (key, verb) => {
      const { pool } = stubPool(undefined, { ...HARDENED, [key]: true });
      const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
      expect(r.error?.code).toBe('append_only_not_enforced');
      expect(r.error?.message).toContain(verb);
    });

  it('refuses to report ok when the GRANT did not take', async () => {
    const { pool } = stubPool(undefined, { ...HARDENED, can_insert: false });
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.error?.code).toBe('append_only_not_enforced');
    expect(r.error?.message).toContain('cannot INSERT or SELECT');
  });

  it.each([
    ['the verification query throws', () => stubPool((sql) => {
      if (sql.includes('has_table_privilege')) throw new Error('no such table');
      return Promise.resolve({ rows: [] });
    })],
    ['the verification returns no row', () => stubPool(undefined, null)],
  ])('reports append_only_unverified when %s, never ok', async (_label, make) => {
    const { pool } = make();
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('append_only_unverified');
    expect(r.error?.type).toBe('integrity');
  });

  // The empty-row branch is SUBSUMED by the catch below it: without it, indexing undefined throws
  // a TypeError that lands on the same code. Measured in the sweep, where deleting it alone left
  // the suite green. What the branch actually contributes is diagnostics, so that is what this
  // asserts. An operator handed "Cannot read properties of undefined" learns nothing about which
  // table could not be read.
  it('names the table it could not read privileges on, rather than surfacing a TypeError', async () => {
    const { pool } = stubPool(undefined, null);
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.error!.message).toContain('could not read privileges on scratch_tbl');
    expect(r.error!.message).not.toContain('undefined');
  });

  it('never touches the pool when the role is invalid', async () => {
    const { pool, calls } = stubPool();
    const r = await applyAppendOnlyGuards(pool, { role: INJECTION, table: 'scratch_tbl' });
    expect(r.error?.code).toBe('invalid_identifier');
    expect(r.error?.type).toBe('validation');
    expect(calls).toEqual([]);
  });

  it('never touches the pool when the table is invalid', async () => {
    const { pool, calls } = stubPool();
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: INJECTION });
    expect(r.error?.code).toBe('invalid_identifier');
    expect(r.error?.type).toBe('validation');
    expect(calls).toEqual([]);
  });

  // Fail-closed: a server-side failure must surface as a typed err, never as a thrown pg error
  // and never as ok. A caller that saw ok here would deploy believing the table was hardened.
  it('maps a failing statement to append_only_apply_failed, rolls back, and stops there', async () => {
    const { pool, calls, released } = stubPool(async (sql) => {
      if (sql.startsWith('REVOKE')) throw new Error('permission denied');
      return { rows: [HARDENED] };
    });
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('append_only_apply_failed');
    expect(r.error?.type).toBe('transient');
    expect(calls.some((c) => c.startsWith('GRANT'))).toBe(false);
    expect(calls.some((c) => c.includes('has_table_privilege'))).toBe(false);
    // The rollback is what turns "partially hardened, and nobody can tell" into "nothing applied".
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(released()).toBe(1);
  });

  it('reports append_only_apply_failed when no connection can be acquired', async () => {
    const pool = { connect: async () => { throw new Error('pool exhausted'); } } as unknown as pg.Pool;
    const r = await applyAppendOnlyGuards(pool, { role: 'app_role', table: 'scratch_tbl' });
    expect(r.error?.code).toBe('append_only_apply_failed');
  });
});
