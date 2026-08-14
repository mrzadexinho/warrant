// ceremony-checks.ts: the executable form of the ceremony gate (design spec section 12.3, master
// plan line 272). Pure orchestration over injectable dependencies so the whole thing is unit
// testable with no database and no network; src/ceremony-cli.ts only formats the result and picks
// an exit code.
//
// EVERY check is fail-closed and INDEPENDENT. One failing check does not short-circuit the others,
// because an operator far from a keyboard needs the full list, not the first item on it. But `ok`
// is true only when every check passed: there is no partial credit, and no check may be skipped
// because an earlier one failed. A skipped check is reported as a FAILED check named `skipped`,
// never as a pass, which is the same rule mapReviewDecision follows for an unreadable status.
import { preflightGatewerkTemplate } from '@idriszade/warrant-gatewerk';
import type pg from 'pg';
import type { CeremonyConfig } from './config.js';
import { assertLedgerAppendOnly } from './ceremony-preflight.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CeremonyPreflightReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface PreflightDeps {
  /** Injected in tests; production passes the real global fetch through. */
  fetchImpl?: typeof fetch;
  /** Returns a pool connected AS THE APP ROLE. The privilege probe is meaningless otherwise. */
  openAppPool: () => Promise<pg.Pool>;
}

function pass(name: string, detail: string): CheckResult { return { name, ok: true, detail }; }
function fail(name: string, detail: string): CheckResult { return { name, ok: false, detail }; }

async function checkTemplate(cfg: CeremonyConfig, fetchImpl?: typeof fetch): Promise<CheckResult> {
  const name = 'gatewerk-template-not-auto-approve';
  const r = await preflightGatewerkTemplate({
    baseUrl: cfg.gatewerk.baseUrl,
    apiKey: cfg.gatewerk.apiKey,
    templateSlug: cfg.gatewerk.templateSlug,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  if (r.error) return fail(name, `${r.error.code}: ${r.error.message}`);
  // The adapter reports timeout_seconds without judging it, because whether a value is acceptable
  // depends on how long the human running the ceremony will take, which the adapter cannot know.
  // Here we can decide, and the answer is no: Gatewerk inherits the template default into
  // expires_at (crud.ts:98) even though C6 never sends a timeout, and the worker then expires the
  // review. Warrant reads an expired review as a rejection, so this is fail-closed rather than
  // dangerous, but it kills a live ceremony for no visible reason, which is exactly the failure
  // this preflight exists to catch before rather than during the run.
  if (r.data.timeoutSeconds !== null) {
    return fail(
      name,
      `preflight_template_timeout_seconds: template ${r.data.slug} sets timeout_seconds=`
        + `${r.data.timeoutSeconds}, which Gatewerk inherits into expires_at. The ceremony review `
        + 'would expire mid-run and warrant would read that as a rejection. Clear it first.',
    );
  }
  return pass(
    name,
    `template ${r.data.slug} (${r.data.templateId}) has auto_approve=false and no timeout default`,
  );
}

async function checkLedger(deps: PreflightDeps): Promise<CheckResult> {
  const name = 'ledger-append-only';
  let pool: pg.Pool;
  try {
    pool = await deps.openAppPool();
  } catch (e) {
    return fail(name, `could not open the app-role pool: ${String(e)}`);
  }
  try {
    const r = await assertLedgerAppendOnly(pool);
    if (r.error) return fail(name, `${r.error.code}: ${r.error.message}`);
    const p = r.data;
    return pass(
      name,
      `role ${p.currentUser} on ${p.table} (owner ${p.owner}): insert+select only, `
        + 'update/delete/truncate revoked, both triggers enabled',
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Runs every ceremony gate. `cfg` has already been validated by loadCeremonyConfig, so the checks
 * here are the ones that can only be answered by asking the live deployment.
 */
export async function runCeremonyPreflight(
  cfg: CeremonyConfig,
  deps: PreflightDeps,
): Promise<CeremonyPreflightReport> {
  // Deliberately sequential and independently caught: a thrown check must become a FAILED check,
  // never an unhandled rejection that takes the process down before the other results print.
  const checks: CheckResult[] = [];

  for (const [name, run] of [
    ['gatewerk-template-not-auto-approve', () => checkTemplate(cfg, deps.fetchImpl)],
    ['ledger-append-only', () => checkLedger(deps)],
  ] as const) {
    try {
      checks.push(await run());
    } catch (e) {
      checks.push(fail(name, `check threw: ${String(e)}`));
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatPreflightReport(report: CeremonyPreflightReport): string {
  const lines = report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`);
  lines.push('');
  lines.push(report.ok ? 'Ceremony preflight PASSED.' : 'Ceremony preflight FAILED. Do not run the ceremony.');
  return lines.join('\n') + '\n';
}
