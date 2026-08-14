#!/usr/bin/env node
// ceremony-cli.ts: the operator surface for the live run. Three subcommands, no hidden behaviour.
//
//   keygen     generate the ceremony keypair. Prints the PUBLIC key to stdout; the private half only
//              with --print-private, so it cannot land in a scrollback or a CI log by accident.
//   provision  create the three tables the ceremony writes to (ledger, parks, outbox) as the ADMIN
//              role and apply the guards. Idempotent. `pnpm provision:ledger` covers only the first
//              of the three: a run missing the other two can reach a human approval and then die
//              on the resume.
//   preflight  every gate that must pass before the run. Exit 0 only when EVERY check passed.
//   drain      one governed drain pass. This is the step that sends real email, so it is a
//              separate explicit command and never runs as a side effect of the other two.
//
// Exit codes are part of the product surface: 0 success, 1 a check or a drain refusal, 2 usage.
// Anything a script can branch on is an assertion target: a passing test suite that only asserts
// on stdout would not catch an exit code that disagreed with the printed result.
import pg from 'pg';
import { generateKeyPair } from '@idriszade/warrant-core';
import { drainOutbox, PostgresDrainerLock } from '@idriszade/warrant-eve';
import { isCeremonyEnabled, loadCeremonyConfig } from './config.js';
import { buildCeremonyRuntime } from './ceremony-deps.js';
import { formatPreflightReport, runCeremonyPreflight } from './ceremony-checks.js';
import { buildSmtpSender } from './smtp-sender.js';

const USAGE = 'Usage: warrant-ceremony <keygen [--print-private] | provision | preflight | drain>\n';

function die(msg: string, code: number): never {
  process.stderr.write(msg);
  process.exit(code);
}

function keygen(printPrivate: boolean): void {
  const kp = generateKeyPair();
  process.stdout.write(`public_key_hex=${kp.publicKeyHex}\n`);
  if (printPrivate) {
    process.stdout.write(`WARRANT_PRIVATE_KEY_HEX=${kp.privateKeyHex}\n`);
  } else {
    process.stderr.write('private key withheld; re-run with --print-private to emit it\n');
  }
}

function requireConfig() {
  if (!isCeremonyEnabled()) die('WARRANT_CEREMONY is not 1; refusing to act on a live deployment\n', 2);
  const cfg = loadCeremonyConfig();
  if (cfg.error) die(`${cfg.error.message}\n`, 1);
  return cfg.data;
}

/**
 * Create the three tables the ceremony writes to, as the ADMIN role, and apply the append-only
 * guards and runtime grants. Idempotent: every statement is `IF NOT EXISTS` or a re-GRANT.
 *
 * `pnpm provision:ledger` creates `warrant_ledger` only. The park store and the outbox are equally
 * required and equally Postgres-backed: a database missing either can let a ceremony run reach a
 * **human approval** and then die on the resume with `db_error`, because `parkStore.get()`
 * addresses a relation that does not exist, after the Gatewerk review has already been decided by
 * a person.
 */
async function provision(): Promise<void> {
  const cfg = requireConfig();
  const runtime = buildCeremonyRuntime(cfg);
  try {
    const r = await runtime.ensureSchema();
    if (r.error) die(`provision failed: ${r.error.code}: ${r.error.message}\n`, 1);
    process.stdout.write('OK  warrant_ledger, warrant_eve_parks, warrant_eve_outbox created/verified\n');
    process.stdout.write('OK  append-only guards and runtime grants applied\n');
  } finally {
    await runtime.close();
  }
}

async function preflight(): Promise<void> {
  const cfg = requireConfig();
  const report = await runCeremonyPreflight(cfg, {
    openAppPool: async () => new pg.Pool({ connectionString: cfg.ledgerDatabaseUrl }),
  });
  process.stdout.write(formatPreflightReport(report));
  process.exit(report.ok ? 0 : 1);
}

async function drain(): Promise<void> {
  const cfg = requireConfig();
  const runtime = buildCeremonyRuntime(cfg);
  try {
    const sender = buildSmtpSender({ ...cfg.smtp, allowedRecipients: cfg.allowedRecipients });
    const result = await drainOutbox(
      {
        ledger: runtime.deps.ledger,
        publicKeyHex: runtime.deps.publicKeyHex,
        now: runtime.deps.now,
        principal: { kind: 'agent', id: 'warrant-eve-outbound' },
      },
      // The advisory lock is what makes "one drainer" true rather than assumed: without it two
      // drain processes can both pass the already-terminal check (section 8 step 7) and both send.
      { outbox: runtime.outbox, sender, lock: new PostgresDrainerLock(runtime.pool) },
    );
    if (result.error) die(`drain failed: ${result.error.code}: ${result.error.message}\n`, 1);
    for (const r of result.data) {
      process.stdout.write(`${r.status.toUpperCase()}  ${r.requestId}  ${JSON.stringify(r)}\n`);
    }
    // A refusal is not a success. An operator scripting the ceremony must be able to branch on
    // "did anything fail to send" without parsing stdout.
    process.exitCode = result.data.some((r) => r.status === 'failed') ? 1 : 0;
  } finally {
    await runtime.close();
  }
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'keygen') keygen(argv.includes('--print-private'));
else if (cmd === 'provision') await provision();
else if (cmd === 'preflight') await preflight();
else if (cmd === 'drain') await drain();
else die(USAGE, 2);
