// The ceremony gate as a whole (design spec section 12.3). The properties that matter here are
// structural rather than cryptographic: every check runs, one failure never suppresses another's
// result, a check that throws becomes a FAILED check rather than an unhandled rejection, and `ok`
// is the conjunction of all of them with no partial credit.
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { formatPreflightReport, runCeremonyPreflight } from '../src/ceremony-checks.js';
import { loadCeremonyConfig } from '../src/config.js';
import type { CeremonyConfig, Env } from '../src/config.js';

const ENV: Env = {
  WARRANT_CEREMONY: '1',
  WARRANT_PRIVATE_KEY_HEX: 'a1'.repeat(32),
  WARRANT_LEDGER_DATABASE_URL: 'postgresql://app@127.0.0.1:1/warrant',
  WARRANT_LEDGER_ADMIN_DATABASE_URL: 'postgresql://admin@127.0.0.1:1/warrant',
  WARRANT_LEDGER_APP_ROLE: 'warrant_app',
  GATEWERK_BASE_URL: 'https://gatewerk.example.com',
  GATEWERK_API_KEY: 'gwk_live_abc',
  GATEWERK_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
  GATEWERK_TEMPLATE_SLUG: 'warrant-outbound-email', // deliberately supplied: the loader refuses an absent or empty slug
    WARRANT_TRIGGER_SECRET: 'trigger-secret-0123456789abcdef',
  PUBLIC_BASE_URL: 'https://agent.example.com',
  SMTP_HOST: 'smtp.protonmail.ch',
  SMTP_PORT: '587',
  SMTP_USER: 'u@example.com',
  SMTP_PASSWORD: 'tok',
  WARRANT_CEREMONY_FROM: 'u@example.com',
  OPENAI_API_KEY: 'sk-test',
  WARRANT_CEREMONY_ALLOWED_RECIPIENTS: 'idris@example.com',
};

const CFG: CeremonyConfig = loadCeremonyConfig(ENV).data!;

function templatesResponse(over: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    object: 'list',
    items: [{
      object: 'template', id: 'tpl_1', slug: 'warrant-outbound-email',
      auto_approve: false, timeout_action: null, timeout_seconds: null, ...over,
    }],
    has_more: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A pool stub whose query() answers the catalog probe. `end` is asserted on for cleanup. */
function poolStub(rows: Record<string, unknown>[], triggers: { tgname: string; tgenabled: string }[]) {
  const end = vi.fn(async () => undefined);
  const pool = {
    query: vi.fn(async (sql: string) =>
      (sql.includes('pg_trigger') ? { rows: triggers } : { rows })),
    end,
  } as unknown as pg.Pool;
  return { pool, end };
}

const HARDENED_ROW = {
  current_user: 'warrant_app', owner: 'warrant_admin',
  can_insert: true, can_select: true, can_update: false, can_delete: false, can_truncate: false,
};
const HARDENED_TRIGGERS = [
  { tgname: 'warrant_ledger_append_only_row', tgenabled: 'O' },
  { tgname: 'warrant_ledger_append_only_truncate', tgenabled: 'O' },
];

describe('runCeremonyPreflight', () => {
  it('passes when the template is not auto-approve and the ledger is hardened', async () => {
    const { pool, end } = poolStub([HARDENED_ROW], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()),
      openAppPool: async () => pool,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'gatewerk-template-not-auto-approve', 'ledger-append-only',
    ]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('fails the run when the template auto-approves, naming the code', async () => {
    const { pool } = poolStub([HARDENED_ROW], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse({ auto_approve: true })),
      openAppPool: async () => pool,
    });
    expect(report.ok).toBe(false);
    const tpl = report.checks.find((c) => c.name === 'gatewerk-template-not-auto-approve')!;
    expect(tpl.ok).toBe(false);
    expect(tpl.detail).toContain('preflight_template_auto_approve');
    // The other check still ran and still reported. An operator gets the whole list.
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.ok).toBe(true);
  });

  // The adapter reports timeout_seconds without judging it; this layer is where the judgment
  // lives. Gatewerk inherits the template default into expires_at even though C6 sends no
  // timeout, so the ceremony's review would expire mid-run and warrant would read that as a
  // rejection: fail-closed, and still a dead ceremony nobody could explain.
  it.each([[86400], [3600], [60]])('fails the run when the template sets timeout_seconds %i', async (secs) => {
    const { pool } = poolStub([HARDENED_ROW], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse({ timeout_seconds: secs })),
      openAppPool: async () => pool,
    });
    expect(report.ok).toBe(false);
    const tpl = report.checks.find((c) => c.name === 'gatewerk-template-not-auto-approve')!;
    expect(tpl.detail).toContain('preflight_template_timeout_seconds');
    expect(tpl.detail).toContain(String(secs));
  });

  it('passes when the template sets no timeout default', async () => {
    const { pool } = poolStub([HARDENED_ROW], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse({ timeout_seconds: null })),
      openAppPool: async () => pool,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'gatewerk-template-not-auto-approve')!.detail)
      .toContain('no timeout default');
  });

  it.each([
    ['role still holds UPDATE', { can_update: true }, 'ledger_role_can_update'],
    ['role still holds DELETE', { can_delete: true }, 'ledger_role_can_delete'],
    ['role still holds TRUNCATE', { can_truncate: true }, 'ledger_role_can_truncate'],
    ['role cannot INSERT', { can_insert: false }, 'ledger_role_cannot_append'],
  ])('fails the run when the %s', async (_label, over, code) => {
    const { pool } = poolStub([{ ...HARDENED_ROW, ...over }], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.detail).toContain(code);
  });

  // The one that actually decides whether any of the hardening binds. An owner can DROP TRIGGER
  // and is not bound by REVOKE, so a self-owned audit table has no append-only property at all.
  it('fails the run when the app role OWNS the ledger table, even with everything else perfect', async () => {
    const { pool } = poolStub(
      [{ ...HARDENED_ROW, owner: 'warrant_app', can_update: false, can_delete: false, can_truncate: false }],
      HARDENED_TRIGGERS,
    );
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(report.ok).toBe(false);
    const detail = report.checks.find((c) => c.name === 'ledger-append-only')!.detail;
    expect(detail).toContain('ledger_role_owns_table');
    expect(detail).toContain('OWNS');
  });

  it.each([
    ['the row trigger is missing', [HARDENED_TRIGGERS[1]!], 'ledger_row_trigger_missing'],
    ['the truncate trigger is missing', [HARDENED_TRIGGERS[0]!], 'ledger_truncate_trigger_missing'],
    ['the row trigger is disabled',
      [{ tgname: 'warrant_ledger_append_only_row', tgenabled: 'D' }, HARDENED_TRIGGERS[1]!],
      'ledger_row_trigger_missing'],
  ])('fails the run when %s', async (_label, triggers, code) => {
    const { pool } = poolStub([HARDENED_ROW], triggers);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.detail).toContain(code);
  });

  it('reports a missing ledger table rather than treating an empty result as a pass', async () => {
    const { pool } = poolStub([], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.detail)
      .toContain('ledger_table_missing');
  });

  it('turns a pool that will not open into a FAILED check, not a crash', async () => {
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()),
      openAppPool: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.detail).toContain('ECONNREFUSED');
  });

  it('turns a probe query that throws into a FAILED check', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('permission denied'); }),
      end: vi.fn(async () => undefined) } as unknown as pg.Pool;
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(report.checks.find((c) => c.name === 'ledger-append-only')!.detail)
      .toContain('ledger_probe_failed');
  });

  it('turns an unreachable Gatewerk into a FAILED check rather than a pass', async () => {
    const { pool } = poolStub([HARDENED_ROW], HARDENED_TRIGGERS);
    const report = await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => { throw new Error('network down'); }),
      openAppPool: async () => pool,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'gatewerk-template-not-auto-approve')!.detail)
      .toContain('gate_unreachable');
  });

  it('closes the app pool even when the ledger check fails', async () => {
    const { pool, end } = poolStub([{ ...HARDENED_ROW, can_update: true }], HARDENED_TRIGGERS);
    await runCeremonyPreflight(CFG, {
      fetchImpl: vi.fn(async () => templatesResponse()), openAppPool: async () => pool,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('formatPreflightReport', () => {
  it('marks each check and refuses the run in plain words when any failed', () => {
    const out = formatPreflightReport({
      ok: false,
      checks: [{ name: 'a', ok: true, detail: 'fine' }, { name: 'b', ok: false, detail: 'broken' }],
    });
    expect(out).toContain('PASS  a');
    expect(out).toContain('FAIL  b');
    expect(out).toContain('Do not run the ceremony.');
  });

  it('says PASSED only when every check passed', () => {
    const out = formatPreflightReport({ ok: true, checks: [{ name: 'a', ok: true, detail: 'fine' }] });
    expect(out).toContain('Ceremony preflight PASSED.');
    expect(out).not.toContain('Do not run the ceremony.');
  });
});
