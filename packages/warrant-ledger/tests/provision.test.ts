// provision.test.ts: the pure half of the provisioning entrypoint. readProvisionEnv is a pure
// function precisely so every refusal is testable with no database and no process environment in
// reach, and provisionLedger is driven through stubbed pools.
//
// The live proof is running it against the real deployment, which is not something a suite can do.
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { readProvisionEnv } from '../src/provision-cli.js';
import { provisionLedger } from '../src/provision.js';

const GOOD = {
  WARRANT_LEDGER_ADMIN_DATABASE_URL: 'postgres://warrant_owner:pw1@127.0.0.1:5433/warrant',
  WARRANT_LEDGER_DATABASE_URL: 'postgres://warrant_app:pw2@127.0.0.1:5433/warrant',
  WARRANT_LEDGER_APP_ROLE: 'warrant_app',
};

describe('readProvisionEnv', () => {
  it('accepts a complete environment and defaults the table', () => {
    const r = readProvisionEnv({ ...GOOD });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({
      adminUrl: GOOD.WARRANT_LEDGER_ADMIN_DATABASE_URL,
      appUrl: GOOD.WARRANT_LEDGER_DATABASE_URL,
      appRole: 'warrant_app',
      table: 'warrant_ledger',
    });
  });

  it('reports every missing variable at once, not just the first', () => {
    const r = readProvisionEnv({});
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('provision_env_invalid');
    expect(r.error?.message).toContain('WARRANT_LEDGER_ADMIN_DATABASE_URL');
    expect(r.error?.message).toContain('WARRANT_LEDGER_DATABASE_URL');
    expect(r.error?.message).toContain('WARRANT_LEDGER_APP_ROLE');
  });

  it('treats an empty and a whitespace-only value as missing', () => {
    const r = readProvisionEnv({ ...GOOD, WARRANT_LEDGER_APP_ROLE: '   ' });
    expect(r.error?.message).toContain('WARRANT_LEDGER_APP_ROLE is missing or empty');
  });

  // Guards against: a secrets file deployed with <SUPER>/<OWNER>/<APP> still
  // in it, on a container that comes up healthy.
  it('refuses a value with a surviving placeholder', () => {
    const r = readProvisionEnv({
      ...GOOD,
      WARRANT_LEDGER_DATABASE_URL: 'postgres://warrant_app:<APP>@127.0.0.1:5433/warrant',
    });
    expect(r.data).toBeNull();
    expect(r.error?.message).toContain('placeholder');
  });

  it('refuses a role that is not a plain SQL identifier', () => {
    const r = readProvisionEnv({ ...GOOD, WARRANT_LEDGER_APP_ROLE: 'warrant-app' });
    expect(r.error?.message).toContain('plain SQL identifier');
  });

  it('refuses a table that is not a plain SQL identifier', () => {
    const r = readProvisionEnv({ ...GOOD, WARRANT_LEDGER_TABLE: 'x"; DROP TABLE warrant_ledger; --' });
    expect(r.error?.message).toContain('plain SQL identifier');
  });

  // Both URLs the same means the proof runs on the owner connection, which measures a role the
  // application never uses. It would still fail (as ledger_role_owns_table) but pointing at the
  // database instead of at the environment.
  it('refuses identical admin and application URLs', () => {
    const r = readProvisionEnv({ ...GOOD, WARRANT_LEDGER_DATABASE_URL: GOOD.WARRANT_LEDGER_ADMIN_DATABASE_URL });
    expect(r.data).toBeNull();
    expect(r.error?.message).toContain('identical');
  });
});

// ---------------------------------------------------------------------------
// provisionLedger through stubbed pools.
// ---------------------------------------------------------------------------
const HARDENED = { can_insert: true, can_select: true, can_update: false, can_delete: false, can_truncate: false };

/** Answers ensureTable's DDL and applyAppendOnlyGuards' transaction plus its verification read. */
function ownerPool(): pg.Pool {
  const query = async (sql: string) => {
    if (sql.includes('has_table_privilege')) return { rows: [HARDENED] };
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

/** Answers assertLedgerAppendOnly's two catalog reads as the named role. */
function appPool(currentUser: string, owner = 'warrant_owner'): pg.Pool {
  const query = async (sql: string) => {
    if (sql.includes('pg_trigger')) {
      return {
        rows: [
          { tgname: 'warrant_ledger_append_only_row', tgenabled: 'O' },
          { tgname: 'warrant_ledger_append_only_truncate', tgenabled: 'O' },
        ],
      };
    }
    return { rows: [{ current_user: currentUser, owner, ...HARDENED }] };
  };
  return { query } as unknown as pg.Pool;
}

describe('provisionLedger', () => {
  it('returns the proof when the application credential is the hardened role', async () => {
    const r = await provisionLedger(ownerPool(), appPool('warrant_app'), { appRole: 'warrant_app' });
    expect(r.error).toBeNull();
    expect(r.data?.currentUser).toBe('warrant_app');
    expect(r.data?.owner).toBe('warrant_owner');
    expect(r.data?.canUpdate).toBe(false);
  });

  // The check assertLedgerAppendOnly cannot make: every posture property holds for ANY non-owner
  // role, so a URL pointing at the wrong one reports a perfectly hardened ledger that the
  // application does not use. Without this the tool's success claim would be about a stranger.
  it('refuses when the application credential authenticated as a different role', async () => {
    const r = await provisionLedger(ownerPool(), appPool('millwerk_app'), { appRole: 'warrant_app' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('app_role_mismatch');
    expect(r.error?.message).toContain('millwerk_app');
  });

  it('refuses when the application credential owns the table', async () => {
    const r = await provisionLedger(
      ownerPool(),
      appPool('warrant_owner', 'warrant_owner'),
      { appRole: 'warrant_owner' },
    );
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('ledger_role_owns_table');
  });

  it('surfaces a failure from ensureTable rather than continuing', async () => {
    const broken = {
      query: async () => { throw new Error('relation cannot be created'); },
      connect: async () => { throw new Error('unreachable'); },
    } as unknown as pg.Pool;
    const r = await provisionLedger(broken, appPool('warrant_app'), { appRole: 'warrant_app' });
    expect(r.data).toBeNull();
    expect(r.error?.code).toBe('ensure_table_failed');
  });
});
