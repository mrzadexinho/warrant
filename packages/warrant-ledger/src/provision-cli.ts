// provision-cli.ts: the operator-facing entrypoint for provisionLedger.
//
// Run from the repo root, against a tunnel to the deployment:
//
//   ssh -f -N -L 5433:127.0.0.1:5433 <host>
//   WARRANT_LEDGER_ADMIN_DATABASE_URL=... \
//   WARRANT_LEDGER_DATABASE_URL=... \
//   WARRANT_LEDGER_APP_ROLE=warrant_app \
//     pnpm provision:ledger
//
// It prints the proof and NEVER the connection strings, which carry passwords.
//
// The placeholder check is not defensive noise: a `.env` written with `<SUPER>`/`<OWNER>`/`<APP>`
// still in it lets Postgres initialise with those literal strings as passwords, with the container
// coming up HEALTHY: nothing looks wrong until someone reads the file. `deploy-service.sh` refuses
// placeholders for the same reason. An instruction is not a guard, and every tool that consumes
// those secrets has to say so independently.
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { DEFAULT_LEDGER_TABLE } from './append-only.js';
import { provisionLedger } from './provision.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ProvisionEnv {
  readonly adminUrl: string;
  readonly appUrl: string;
  readonly appRole: string;
  readonly table: string;
}

/**
 * Pure, so the refusals are testable with no database and no process in reach. Collects every
 * problem rather than stopping at the first: an operator fixing one variable per run is how a
 * five-minute step becomes a twenty-minute one.
 */
export function readProvisionEnv(env: Record<string, string | undefined>): Result<ProvisionEnv, WarrantError> {
  const problems: string[] = [];

  const req = (name: string): string => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} is missing or empty`);
      return '';
    }
    const value = raw.trim();
    // A template that survived a copy-paste. Angle brackets are legal in neither a Postgres URL nor
    // a role name, so this cannot reject a real value.
    if (/[<>]/.test(value)) {
      problems.push(`${name} still contains a placeholder (angle brackets): substitute a real value`);
    }
    return value;
  };

  const adminUrl = req('WARRANT_LEDGER_ADMIN_DATABASE_URL');
  const appUrl = req('WARRANT_LEDGER_DATABASE_URL');
  const appRole = req('WARRANT_LEDGER_APP_ROLE');
  const table = env['WARRANT_LEDGER_TABLE']?.trim() || DEFAULT_LEDGER_TABLE;

  if (appRole !== '' && !IDENT.test(appRole)) {
    problems.push(`WARRANT_LEDGER_APP_ROLE must be a plain SQL identifier, got ${JSON.stringify(appRole)}`);
  }
  if (!IDENT.test(table)) {
    problems.push(`WARRANT_LEDGER_TABLE must be a plain SQL identifier, got ${JSON.stringify(table)}`);
  }
  // Same URL for both roles means the "prove it through the application's own credential" property
  // is gone: the proof would run on the owner connection and assertLedgerAppendOnly would correctly
  // report ledger_role_owns_table, but the message would send the reader looking at the database
  // rather than at their environment.
  if (adminUrl !== '' && adminUrl === appUrl) {
    problems.push(
      'WARRANT_LEDGER_ADMIN_DATABASE_URL and WARRANT_LEDGER_DATABASE_URL are identical; the admin URL '
        + 'must be the owner role and the other the application role, or the proof measures the wrong role',
    );
  }

  if (problems.length > 0) {
    return err({ type: 'validation', code: 'provision_env_invalid', message: problems.join('; ') });
  }
  return ok({ adminUrl, appUrl, appRole, table });
}

async function main(): Promise<number> {
  const cfg = readProvisionEnv(process.env);
  if (cfg.error !== null) {
    console.error(`REFUSED: ${cfg.error.message}`);
    return 1;
  }
  const { adminUrl, appUrl, appRole, table } = cfg.data;

  const owner = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const app = new pg.Pool({ connectionString: appUrl, max: 2 });
  try {
    const r = await provisionLedger(owner, app, { appRole, table });
    if (r.error !== null) {
      console.error(`NOT APPEND-ONLY [${r.error.code}]: ${r.error.message}`);
      return 1;
    }
    const p = r.data;
    console.log(`table            ${p.table}`);
    console.log(`owner            ${p.owner}`);
    console.log(`application role ${p.currentUser}`);
    console.log(`  INSERT ${p.canInsert}  SELECT ${p.canSelect}`);
    console.log(`  UPDATE ${p.canUpdate}  DELETE ${p.canDelete}  TRUNCATE ${p.canTruncate}`);
    console.log(`  triggers: row=${p.rowTriggerEnabled} truncate=${p.truncateTriggerEnabled}`);
    console.log('APPEND-ONLY: proved through the application credential.');
    return 0;
  } finally {
    await owner.end().catch(() => undefined);
    await app.end().catch(() => undefined);
  }
}

// Guarded so the tests can import readProvisionEnv without opening a connection to anything.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
