// Shared deps singleton for one running eve process. Both routes of the
// warrant-trigger channel (`/warrant/v1/run` and `/warrant/v1/gatewerk/review`) and send_email
// must observe the same ledger/parkStore: a park written by the trigger route has to be visible to
// the review route's resumeByPoll, and
// send_email's approval()/execute() write to the same ledger. buildDeps() (src/build.ts)
// constructs a new MemoryLedger and a new SimGate on every call: calling it twice in one
// process would give each caller its own private, mutually invisible ledger, and the
// failure is total and silent (approval writes to ledger A, resumeByPoll reads ledger B
// and finds nothing, or worse mints into B while execute reads C and throws
// warrant_missing). getDeps() memoizes so the whole process shares exactly one
// WarrantEveDeps instance. buildDeps() remains the TEST-ONLY factory: no production
// module may call it directly.
//
// This is the seam the ceremony swaps, and it is the only place that decides. WARRANT_CEREMONY=1
// selects the real keypair, the real clock, randomUUID, a PostgresLedger, a live GatewerkGate and
// a PostgresOutbox; anything else keeps the demo runtime byte for byte.
//
// THERE IS NO FALLBACK. Ceremony mode with an unusable configuration THROWS and the process refuses
// to start. Falling back to buildDeps() would sign a real certificate with the demo keypair whose
// private half is published in src/build.ts, and stamp it with a frozen demo clock: a document
// asserting an authorization nobody could distinguish from a forgery.
import { buildDeps } from './build.js';
import { buildCeremonyRuntime } from './ceremony-deps.js';
import type { CeremonyRuntime } from './ceremony-deps.js';
import { isCeremonyEnabled, loadCeremonyConfig } from './config.js';
import type { WarrantEveDeps } from '@idriszade/warrant-eve';

let cached: WarrantEveDeps | undefined;
let cachedRuntime: CeremonyRuntime | undefined;

/**
 * The ceremony runtime, including the pool and outbox the drainer needs. Throws when ceremony mode
 * is off, so no caller can reach a Postgres outbox while the process is running on MemoryLedger.
 */
export function getCeremonyRuntime(): CeremonyRuntime {
  if (!isCeremonyEnabled()) {
    throw new Error('ceremony_not_enabled: WARRANT_CEREMONY is not 1');
  }
  if (cachedRuntime === undefined) {
    const cfg = loadCeremonyConfig();
    if (cfg.error) throw new Error(cfg.error.message);
    cachedRuntime = buildCeremonyRuntime(cfg.data);
  }
  return cachedRuntime;
}

export function getDeps(): WarrantEveDeps {
  if (cached === undefined) {
    cached = isCeremonyEnabled() ? getCeremonyRuntime().deps : buildDeps();
  }
  return cached;
}
