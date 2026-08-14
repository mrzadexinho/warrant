// ceremony-deps.ts: the six knobs swapped from their demo values.
//
//   knob        demo (src/build.ts)                ceremony (here)
//   keys        generateKeyPair('22' x 32)         real keypair, private half from env
//   now         frozen 2026-07-18T12:00:00Z        () => new Date()
//   newId       `demo-id-${++tick}`                randomUUID()
//   ledger      MemoryLedger                       PostgresLedger (the proof must outlive the run)
//   gate        SimGate(['approve','edit'])        GatewerkGate against the live API
//   side effect in-memory outbox[]                 PostgresOutbox drained to SMTP
//
// buildDeps() in src/build.ts stays exactly as it was and stays test-only. This module
// is the other branch of the same singleton seam, so the whole process still shares one ledger, one
// park store and one outbox: splitting them would be total and silent.
//
// This module does NOT import smtp-sender.ts. The drainer is a separate process (src/ceremony-cli.ts)
// and keeping nodemailer out of this import graph keeps it out of the eve bundle.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateKeyPair } from '@idriszade/warrant-core';
import { PostgresLedger, applyAppendOnlyGuards } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { defaultGtmPolicy } from '@idriszade/warrant-pack-gtm';
import { PostgresParkStore, PostgresOutbox, applyRuntimeGrants } from '@idriszade/warrant-eve';
import type { WarrantEveDeps } from '@idriszade/warrant-eve';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { CeremonyConfig } from './config.js';

export interface CeremonyRuntime {
  deps: WarrantEveDeps;
  outbox: PostgresOutbox;
  /** Runtime pool, connected as the least-privilege app role. Cannot run the DDL below. */
  pool: pg.Pool;
  /** Admin pool, used only by ensureSchema. Held open so ceremony-cli can close it. */
  adminPool: pg.Pool;
  ensureSchema(): Promise<Result<void, WarrantError>>;
  close(): Promise<void>;
}

export function buildCeremonyRuntime(cfg: CeremonyConfig): CeremonyRuntime {
  const pool = new pg.Pool({ connectionString: cfg.ledgerDatabaseUrl });
  const adminPool = new pg.Pool({ connectionString: cfg.ledgerAdminDatabaseUrl });

  const ledger = new PostgresLedger(pool);
  const parkStore = new PostgresParkStore(pool);
  const outbox = new PostgresOutbox(pool);

  const deps: WarrantEveDeps = {
    policy: defaultGtmPolicy(),
    keys: generateKeyPair(cfg.privateKeyHex),
    publicKeyHex: cfg.publicKeyHex,
    ledger,
    gate: new GatewerkGate({
      baseUrl: cfg.gatewerk.baseUrl,
      apiKey: cfg.gatewerk.apiKey,
      callbackUrl: cfg.gatewerk.callbackUrl,
      templateSlug: cfg.gatewerk.templateSlug,
    }),
    now: () => new Date(),
    newId: () => randomUUID(),
    autoTtlMs: 60_000,
    humanTtlMs: 3_600_000,
    reviewTimeoutMs: 3_600_000,
    parkStore,
    // Logs EVERY guard evaluation, `proceed` included: deliberately louder than the warrant-eve
    // default, so a stale running image (older than the guard on disk) is visible: a governed call
    // whose log carries no re-entry-guard line is being served by a stale image; restart the eve
    // process before believing anything else about the run.
    onReentryCheck: (info) => {
      // eslint-disable-next-line no-console
      console.error(
        `[ceremony] re-entry guard ran: decision=${info.decision} entries=${info.entries} ` +
        `matched=${info.matched} runId=${info.runId} callId=${info.callId}`,
      );
    },
  };

  return {
    deps,
    outbox,
    pool,
    adminPool,

    // DDL runs on the ADMIN pool by design. The whole point of section 9.1 is that the runtime role
    // holds INSERT+SELECT and nothing else; if it could CREATE TABLE it could also DROP TRIGGER, and
    // the append-only guard would be decorative. Running the schema step as the app role would
    // "succeed" while proving nothing, which is worse than failing.
    async ensureSchema(): Promise<Result<void, WarrantError>> {
      const adminLedger = new PostgresLedger(adminPool);
      const adminParks = new PostgresParkStore(adminPool);
      const adminOutbox = new PostgresOutbox(adminPool);
      try {
        await adminLedger.ensureTable();
        await adminParks.ensureTable();
        await adminOutbox.ensureTable();
      } catch (e) {
        return err({ type: 'transient', code: 'ceremony_schema_failed', message: String(e) });
      }
      const guarded = await applyAppendOnlyGuards(adminPool, { role: cfg.ledgerAppRole });
      if (guarded.error) return guarded;
      // The admin role created these tables, so it owns them and the app role holds NOTHING on
      // them: a fresh Postgres table grants PUBLIC nothing, and applyAppendOnlyGuards speaks only
      // about warrant_ledger. Without this the first governed call that parks fails on
      // `permission denied for table warrant_eve_parks`, after the Gatewerk review already exists.
      const granted = await applyRuntimeGrants(adminPool, { role: cfg.ledgerAppRole });
      if (granted.error) return granted;
      // The park store and the outbox are deliberately NOT append-only. Neither holds authorization
      // data (design spec section 3.3): a park record only routes an eve resume, and an outbox row
      // is re-verified against the signed warrant before a single byte is sent. Locking them down
      // would suggest they carry weight they do not carry.
      return ok(undefined);
    },

    async close(): Promise<void> {
      await Promise.allSettled([pool.end(), adminPool.end()]);
    },
  };
}
