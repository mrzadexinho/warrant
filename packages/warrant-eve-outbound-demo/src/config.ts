// config.ts: the ONE sanctioned process.env reader in this package (global constraint: env is read
// at an agent entrypoint or in src/config.ts, never inside a library module). It turns the ceremony
// environment described in design spec section 10 into a validated CeremonyConfig, or into an error
// naming EVERY problem at once rather than the first.
//
// Fail-closed choices that are load-bearing, not stylistic:
//  - The Milestone A demo private key ('22' repeated 32 times) is REFUSED by name. It is published
//    in src/build.ts and in every copy of this repo. A ceremony certificate signed with a key whose
//    private half is public would assert an authorization anybody could forge: the same class of
//    defect as design spec section 2.2, arriving through the key instead of through the decider.
//  - allowedRecipients has NO default. An empty allowlist is an error, never "send to anyone"
//    (design spec section 14, "Real send reaching an unintended recipient").
//  - PUBLIC_BASE_URL must be https, because Gatewerk calls it back across the internet. localhost is
//    the one exception, so a dry run without a deployment is still possible.
import { generateKeyPair } from '@idriszade/warrant-core';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

/** The Milestone A demo key, refused by name. Kept in sync with src/build.ts DEMO_KEYS. */
export const DEMO_PRIVATE_KEY_HEX = '22'.repeat(32);

export interface CeremonyConfig {
  privateKeyHex: string;
  publicKeyHex: string;
  ledgerDatabaseUrl: string;
  ledgerAdminDatabaseUrl: string;
  ledgerAppRole: string;
  gatewerk: {
    baseUrl: string;
    apiKey: string;
    webhookSecret: string;
    templateSlug: string;
    callbackUrl: string;
  };
  smtp: { host: string; port: number; user: string; password: string; from: string };
  /**
   * Bearer token for `POST /warrant/v1/run`, the only route that starts a ceremony run.
   *
   * Validated here and read by nobody in this object, deliberately. `agent/channels/
   * warrant-trigger.ts` reads `process.env` directly, which is sanctioned: agent entrypoints may.
   * It is loaded here so that **preflight refuses a configuration that cannot start a run**: the
   * guard is fail-closed (an unset secret CLOSES the route), so without this the operator's only
   * signal would be a 401 with no cause named.
   */
  triggerSecret: string;
  openaiApiKey: string;
  model: string;
  publicBaseUrl: string;
  allowedRecipients: readonly string[];
}

export type Env = Record<string, string | undefined>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** WARRANT_CEREMONY=1 is the single switch. Anything else, including unset, is the demo runtime. */
export function isCeremonyEnabled(env: Env = process.env): boolean {
  return (env['WARRANT_CEREMONY'] ?? '').trim() === '1';
}

function req(env: Env, name: string, problems: string[]): string {
  const v = (env[name] ?? '').trim();
  if (v === '') problems.push(`${name} is required`);
  return v;
}

function checkUrl(raw: string, name: string, problems: string[], requireHttps: boolean): string {
  if (raw === '') return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return raw;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (requireHttps && u.protocol !== 'https:' && !local) {
    problems.push(`${name} must use https (localhost is the only exception)`);
  }
  return raw.replace(/\/+$/, '');
}

function checkKey(raw: string, problems: string[]): string {
  if (raw === '') return '';
  if (!HEX64.test(raw)) {
    problems.push('WARRANT_PRIVATE_KEY_HEX must be 64 hex characters (32 bytes)');
    return '';
  }
  if (raw.toLowerCase() === DEMO_PRIVATE_KEY_HEX) {
    problems.push('WARRANT_PRIVATE_KEY_HEX is the published demo key and must not sign a ceremony');
    return '';
  }
  try {
    return generateKeyPair(raw).publicKeyHex;
  } catch (e) {
    problems.push(`WARRANT_PRIVATE_KEY_HEX did not yield a keypair: ${String(e)}`);
    return '';
  }
}

function checkPort(raw: string, problems: string[]): number {
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push('SMTP_PORT must be an integer between 1 and 65535');
    return 0;
  }
  return n;
}

function checkRecipients(raw: string, problems: string[]): string[] {
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  if (list.length === 0) {
    problems.push('WARRANT_CEREMONY_ALLOWED_RECIPIENTS must name at least one recipient');
  }
  for (const r of list) {
    if (!r.includes('@')) problems.push(`WARRANT_CEREMONY_ALLOWED_RECIPIENTS entry is not an address: ${r}`);
  }
  return list;
}

/**
 * Validates the whole ceremony environment. Returns err listing EVERY problem, because an operator
 * fixing one variable per run against a live deployment is how a ceremony gets rushed.
 */
export function loadCeremonyConfig(env: Env = process.env): Result<CeremonyConfig, WarrantError> {
  const problems: string[] = [];

  const privateKeyHex = req(env, 'WARRANT_PRIVATE_KEY_HEX', problems);
  const publicKeyHex = checkKey(privateKeyHex, problems);

  const ledgerDatabaseUrl = req(env, 'WARRANT_LEDGER_DATABASE_URL', problems);
  const ledgerAdminDatabaseUrl = req(env, 'WARRANT_LEDGER_ADMIN_DATABASE_URL', problems);
  const ledgerAppRole = req(env, 'WARRANT_LEDGER_APP_ROLE', problems);
  if (ledgerAppRole !== '' && !IDENT.test(ledgerAppRole)) {
    problems.push('WARRANT_LEDGER_APP_ROLE must be a plain SQL identifier');
  }

  const gatewerkBaseUrl = checkUrl(req(env, 'GATEWERK_BASE_URL', problems), 'GATEWERK_BASE_URL', problems, false);
  const gatewerkApiKey = req(env, 'GATEWERK_API_KEY', problems);
  const webhookSecret = req(env, 'GATEWERK_WEBHOOK_SECRET', problems);
  if (webhookSecret !== '' && webhookSecret.length < 16) {
    problems.push('GATEWERK_WEBHOOK_SECRET must be at least 16 characters');
  }
  // `req`, exactly like its four neighbours above and below, NOT `?? 'warrant-outbound-email'`.
  // `GatewerkGate` has no default for this because a template slug is the last domain word in a
  // domain-blind package; `.env.example` and `ceremony/README.md` both document the variable as
  // "required, no default." A loader-level default would silently reinstate it one layer up, so
  // the removal would be true of the port and false of the thing that constructs the port.
  //
  // `req` refuses both failure modes a hand-written `?? 'default'` presence check would miss:
  // `??` fires only on absent, so a missing variable would get the domain word back; an **empty**
  // `GATEWERK_TEMPLATE_SLUG=` is not absent, so `??` would not fire either, and the slug would
  // become `''`, a required field arriving empty at `GatewerkGate` with nothing objecting. `req`
  // refuses both, because it trims first and tests for `''`.
  const templateSlug = req(env, 'GATEWERK_TEMPLATE_SLUG', problems);

  const publicBaseUrl = checkUrl(req(env, 'PUBLIC_BASE_URL', problems), 'PUBLIC_BASE_URL', problems, true);

  const smtpHost = req(env, 'SMTP_HOST', problems);
  const smtpPort = checkPort(req(env, 'SMTP_PORT', problems), problems);
  const smtpUser = req(env, 'SMTP_USER', problems);
  const smtpPassword = req(env, 'SMTP_PASSWORD', problems);
  const smtpFrom = req(env, 'WARRANT_CEREMONY_FROM', problems);

  // `req` like everything else: see the interface field for why a value this object never reads
  // is nonetheless validated here.
  const triggerSecret = req(env, 'WARRANT_TRIGGER_SECRET', problems);

  const openaiApiKey = req(env, 'OPENAI_API_KEY', problems);
  const model = (env['WARRANT_CEREMONY_MODEL'] ?? 'gpt-5.2').trim();
  if (model === '') problems.push('WARRANT_CEREMONY_MODEL must not be blank when set');

  const allowedRecipients = checkRecipients(env['WARRANT_CEREMONY_ALLOWED_RECIPIENTS'] ?? '', problems);

  if (problems.length > 0) {
    return err({
      type: 'validation',
      code: 'ceremony_config_invalid',
      message: `ceremony configuration rejected:\n  - ${problems.join('\n  - ')}`,
    });
  }

  return ok({
    privateKeyHex,
    publicKeyHex,
    ledgerDatabaseUrl,
    ledgerAdminDatabaseUrl,
    ledgerAppRole,
    gatewerk: {
      baseUrl: gatewerkBaseUrl,
      apiKey: gatewerkApiKey,
      webhookSecret,
      templateSlug,
      callbackUrl: `${publicBaseUrl}/warrant/v1/gatewerk/review`,
    },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, password: smtpPassword, from: smtpFrom },
    triggerSecret,
    openaiApiKey,
    model,
    publicBaseUrl,
    allowedRecipients,
  });
}
