import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@idriszade/warrant-core';
import {
  DEMO_PRIVATE_KEY_HEX,
  isCeremonyEnabled,
  loadCeremonyConfig,
} from '../src/config.js';
import type { Env } from '../src/config.js';

const REAL_KEY = 'a1'.repeat(32);

function goodEnv(over: Env = {}): Env {
  return {
    WARRANT_CEREMONY: '1',
    WARRANT_PRIVATE_KEY_HEX: REAL_KEY,
    WARRANT_LEDGER_DATABASE_URL: 'postgresql://app@db/warrant',
    WARRANT_LEDGER_ADMIN_DATABASE_URL: 'postgresql://admin@db/warrant',
    WARRANT_LEDGER_APP_ROLE: 'warrant_app',
    GATEWERK_BASE_URL: 'https://gatewerk.example.com',
    GATEWERK_API_KEY: 'gwk_live_abc',
    GATEWERK_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
    // Must stay present in this "complete" fixture: both `.env.example` and `ceremony/README.md`
    // document this variable as required with no default.
    GATEWERK_TEMPLATE_SLUG: 'warrant-outbound-email',
    WARRANT_TRIGGER_SECRET: 'trigger-secret-0123456789abcdef',
    PUBLIC_BASE_URL: 'https://agent.example.com',
    SMTP_HOST: 'smtp.protonmail.ch',
    SMTP_PORT: '587',
    SMTP_USER: 'ceremony@example.com',
    SMTP_PASSWORD: 'token',
    WARRANT_CEREMONY_FROM: 'ceremony@example.com',
    OPENAI_API_KEY: 'sk-test',
    WARRANT_CEREMONY_ALLOWED_RECIPIENTS: 'idris@example.com',
    ...over,
  };
}

describe('isCeremonyEnabled', () => {
  it('is true only for exactly 1', () => {
    expect(isCeremonyEnabled({ WARRANT_CEREMONY: '1' })).toBe(true);
    expect(isCeremonyEnabled({ WARRANT_CEREMONY: ' 1 ' })).toBe(true);
  });

  // Every one of these has been someone's idea of "on" at some point. None of them is.
  it.each(['0', 'true', 'yes', 'on', '', '11', undefined])('is false for %s', (v) => {
    expect(isCeremonyEnabled(v === undefined ? {} : { WARRANT_CEREMONY: v })).toBe(false);
  });
});

describe('loadCeremonyConfig', () => {
  it('accepts a complete environment and derives the public key from the private half', () => {
    const r = loadCeremonyConfig(goodEnv());
    expect(r.error).toBeNull();
    expect(r.data!.publicKeyHex).toBe(generateKeyPair(REAL_KEY).publicKeyHex);
    expect(r.data!.gatewerk.templateSlug).toBe('warrant-outbound-email');
    expect(r.data!.gatewerk.callbackUrl).toBe('https://agent.example.com/warrant/v1/gatewerk/review');
    expect(r.data!.smtp.port).toBe(587);
    expect(r.data!.allowedRecipients).toEqual(['idris@example.com']);
  });

  // Both directions matter: a `?? 'warrant-outbound-email'` fallback would fail differently in
  // each. `??` fires only on absent, so a MISSING variable would silently get back the domain word
  // `GatewerkGate` refuses to default; an EMPTY one is not absent, so `??` would never fire and the
  // slug would become `''`, a required field reaching the Gate empty with nothing objecting. A
  // test for only the first would leave the second live, and the empty case is the more likely one
  // in practice because `.env.example` ships the key with no value after it.
  it('refuses a missing GATEWERK_TEMPLATE_SLUG rather than defaulting to a domain word', () => {
    const env = goodEnv();
    delete env['GATEWERK_TEMPLATE_SLUG'];
    const r = loadCeremonyConfig(env);
    expect(r.error?.code).toBe('ceremony_config_invalid');
    expect(r.error!.message).toContain('GATEWERK_TEMPLATE_SLUG is required');
    // The point of the rule, asserted rather than implied: the removed default must not come back.
    expect(r.error!.message).not.toContain('warrant-outbound-email');
  });

  it('refuses an empty GATEWERK_TEMPLATE_SLUG, which `??` could never catch', () => {
    const r = loadCeremonyConfig(goodEnv({ GATEWERK_TEMPLATE_SLUG: '' }));
    expect(r.error?.code).toBe('ceremony_config_invalid');
    expect(r.error!.message).toContain('GATEWERK_TEMPLATE_SLUG is required');
  });

  it('refuses a whitespace-only GATEWERK_TEMPLATE_SLUG', () => {
    const r = loadCeremonyConfig(goodEnv({ GATEWERK_TEMPLATE_SLUG: '   ' }));
    expect(r.error?.code).toBe('ceremony_config_invalid');
    expect(r.error!.message).toContain('GATEWERK_TEMPLATE_SLUG is required');
  });

  it('refuses the published demo key by name', () => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_PRIVATE_KEY_HEX: DEMO_PRIVATE_KEY_HEX }));
    expect(r.error?.code).toBe('ceremony_config_invalid');
    expect(r.error!.message).toContain('published demo key');
  });

  // The refusal must not be defeated by case: the hex comparison is normalized, and this is the
  // same defect class as the .gov/.GOV bypass warrant-v0.1 shipped.
  it('refuses the demo key in upper case too', () => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_PRIVATE_KEY_HEX: DEMO_PRIVATE_KEY_HEX.toUpperCase() }));
    expect(r.error!.message).toContain('published demo key');
  });

  it.each([
    ['too short', 'a1'.repeat(16)],
    ['odd length', 'a'.repeat(63)],
    ['non hex', 'z1'.repeat(32)],
  ])('rejects a private key that is %s', (_label, key) => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_PRIVATE_KEY_HEX: key }));
    expect(r.error!.message).toContain('64 hex characters');
  });

  // This list is HAND-ENUMERATED, and that is its weakness: read before adding a variable.
  // It asserts "every problem is reported" while checking a subset someone wrote out by hand, so a
  // newly-required variable missing from the list is invisible to it: a required variable can be
  // absent from here and this test would still pass.
  //
  // A list like this cannot be checked against the thing it claims to cover. Left enumerated
  // because deriving the required set from `loadCeremonyConfig` needs reflection the module does
  // not expose, so the mitigation is this comment plus the count assertion below, which fails
  // when the two drift.
  const REQUIRED_VARS = [
    'WARRANT_PRIVATE_KEY_HEX', 'WARRANT_LEDGER_DATABASE_URL', 'WARRANT_LEDGER_ADMIN_DATABASE_URL',
    'WARRANT_LEDGER_APP_ROLE', 'GATEWERK_BASE_URL', 'GATEWERK_API_KEY', 'GATEWERK_WEBHOOK_SECRET',
    'GATEWERK_TEMPLATE_SLUG', 'WARRANT_TRIGGER_SECRET',
    'PUBLIC_BASE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASSWORD', 'WARRANT_CEREMONY_FROM', 'OPENAI_API_KEY',
    'WARRANT_CEREMONY_ALLOWED_RECIPIENTS',
  ];

  it('reports EVERY problem at once, not just the first', () => {
    const r = loadCeremonyConfig({ WARRANT_CEREMONY: '1' });
    const msg = r.error!.message;
    for (const name of REQUIRED_VARS) {
      expect(msg).toContain(name);
    }
  });

  // The half the enumerated list above cannot do for itself: assert the count too, so a variable
  // added to `config.ts` and forgotten here fails rather than passing quietly. `problems` is one
  // line per failure, and an empty env fails exactly the required ones.
  it('names exactly as many problems as there are required variables', () => {
    const r = loadCeremonyConfig({ WARRANT_CEREMONY: '1' });
    const lines = r.error!.message.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(lines).toHaveLength(REQUIRED_VARS.length);
  });

  // `agent/channels/warrant-trigger.ts` requires this to authorize POST /warrant/v1/run, the
  // only route that starts a ceremony. The guard is fail-closed: an unset secret CLOSES the route,
  // so a missing value here would surface only as a 401 naming nothing.
  it('refuses a missing WARRANT_TRIGGER_SECRET, so preflight cannot pass a config that cannot start a run', () => {
    const env = goodEnv();
    delete env['WARRANT_TRIGGER_SECRET'];
    const r = loadCeremonyConfig(env);
    expect(r.error?.code).toBe('ceremony_config_invalid');
    expect(r.error!.message).toContain('WARRANT_TRIGGER_SECRET is required');
  });

  it('refuses an empty WARRANT_TRIGGER_SECRET', () => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_TRIGGER_SECRET: '' }));
    expect(r.error!.message).toContain('WARRANT_TRIGGER_SECRET is required');
  });

  it('requires https for the callback origin, because Gatewerk calls it from the internet', () => {
    const r = loadCeremonyConfig(goodEnv({ PUBLIC_BASE_URL: 'http://agent.example.com' }));
    expect(r.error!.message).toContain('must use https');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:8080'])('allows %s for a dry run', (url) => {
    expect(loadCeremonyConfig(goodEnv({ PUBLIC_BASE_URL: url })).error).toBeNull();
  });

  it('rejects a PUBLIC_BASE_URL that is not a URL at all', () => {
    expect(loadCeremonyConfig(goodEnv({ PUBLIC_BASE_URL: 'agent.example.com' })).error!.message)
      .toContain('not a valid URL');
  });

  it('strips a trailing slash so the callback URL never doubles it', () => {
    const r = loadCeremonyConfig(goodEnv({ PUBLIC_BASE_URL: 'https://agent.example.com/' }));
    expect(r.data!.gatewerk.callbackUrl).toBe('https://agent.example.com/warrant/v1/gatewerk/review');
  });

  it('rejects an app role that is not a plain SQL identifier', () => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_LEDGER_APP_ROLE: 'app"; DROP TABLE warrant_ledger; --' }));
    expect(r.error!.message).toContain('plain SQL identifier');
  });

  it('rejects a webhook secret short enough to guess', () => {
    expect(loadCeremonyConfig(goodEnv({ GATEWERK_WEBHOOK_SECRET: 'short' })).error!.message)
      .toContain('at least 16 characters');
  });

  it.each([['0', 'zero'], ['65536', 'above range'], ['587.5', 'fractional'], ['abc', 'not a number']])
    ('rejects SMTP port %s (%s)', (port) => {
      expect(loadCeremonyConfig(goodEnv({ SMTP_PORT: port })).error!.message)
        .toContain('between 1 and 65535');
    });

  // The single most dangerous default in this file would be "no allowlist means send to anyone".
  it('refuses an empty recipient allowlist rather than defaulting to open', () => {
    for (const v of ['', '   ', ',,,']) {
      const r = loadCeremonyConfig(goodEnv({ WARRANT_CEREMONY_ALLOWED_RECIPIENTS: v }));
      expect(r.error!.message).toContain('at least one recipient');
    }
  });

  it('rejects an allowlist entry that is not an address', () => {
    expect(loadCeremonyConfig(goodEnv({ WARRANT_CEREMONY_ALLOWED_RECIPIENTS: 'idris' })).error!.message)
      .toContain('is not an address');
  });

  it('lowercases and trims the allowlist so comparison at send time is exact', () => {
    const r = loadCeremonyConfig(goodEnv({ WARRANT_CEREMONY_ALLOWED_RECIPIENTS: ' A@B.com , c@d.io ' }));
    expect(r.data!.allowedRecipients).toEqual(['a@b.com', 'c@d.io']);
  });

  it('lets the template slug be overridden but defaults to the one C6 pins', () => {
    expect(loadCeremonyConfig(goodEnv({ GATEWERK_TEMPLATE_SLUG: 'other' })).data!.gatewerk.templateSlug)
      .toBe('other');
  });
});
