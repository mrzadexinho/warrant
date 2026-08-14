// The six knobs the ceremony swaps, and the one property that matters more than any of them:
// ceremony mode NEVER falls back to the demo runtime. A demo keypair whose private half is
// published in src/build.ts, or a frozen demo clock, on a real certificate would be a
// false-attestation failure arriving through the wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPair } from '@idriszade/warrant-core';
import { PostgresLedger } from '@idriszade/warrant-ledger';
import { GatewerkGate } from '@idriszade/warrant-gatewerk';
import { PostgresParkStore, PostgresOutbox } from '@idriszade/warrant-eve';
import { buildCeremonyRuntime } from '../src/ceremony-deps.js';
import { loadCeremonyConfig, DEMO_PRIVATE_KEY_HEX } from '../src/config.js';
import type { Env } from '../src/config.js';

const REAL_KEY = 'a1'.repeat(32);

const ENV: Env = {
  WARRANT_CEREMONY: '1',
  WARRANT_PRIVATE_KEY_HEX: REAL_KEY,
  WARRANT_LEDGER_DATABASE_URL: 'postgresql://app@127.0.0.1:1/warrant',
  WARRANT_LEDGER_ADMIN_DATABASE_URL: 'postgresql://admin@127.0.0.1:1/warrant',
  WARRANT_LEDGER_APP_ROLE: 'warrant_app',
  GATEWERK_BASE_URL: 'https://gatewerk.example.com',
  GATEWERK_API_KEY: 'gwk_live_abc',
  GATEWERK_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
  GATEWERK_TEMPLATE_SLUG: 'warrant-outbound-email',
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

// A pg.Pool does not connect until it is queried, so every assertion below runs with no database.
function runtime() {
  const cfg = loadCeremonyConfig(ENV);
  expect(cfg.error).toBeNull();
  return buildCeremonyRuntime(cfg.data!);
}

describe('buildCeremonyRuntime: the six section 9 knobs', () => {
  it('uses the REAL keypair derived from the env private key, not the demo one', async () => {
    const rt = runtime();
    const real = generateKeyPair(REAL_KEY);
    expect(rt.deps.keys.privateKeyHex).toBe(REAL_KEY);
    expect(rt.deps.publicKeyHex).toBe(real.publicKeyHex);
    expect(rt.deps.keys.privateKeyHex).not.toBe(DEMO_PRIVATE_KEY_HEX);
    expect(rt.deps.publicKeyHex).not.toBe(generateKeyPair(DEMO_PRIVATE_KEY_HEX).publicKeyHex);
    await rt.close();
  });

  it('uses a live clock, not the frozen demo instant', async () => {
    const rt = runtime();
    const before = Date.now();
    const a = rt.deps.now().getTime();
    const after = Date.now();
    expect(a).toBeGreaterThanOrEqual(before);
    expect(a).toBeLessThanOrEqual(after);
    // The demo clock is frozen at 2026-07-18T12:00:00.000Z and would fail both bounds above on any
    // other day, so pin it explicitly rather than relying on that.
    expect(rt.deps.now().toISOString()).not.toBe('2026-07-18T12:00:00.000Z');
    await rt.close();
  });

  it('uses randomUUID, not the demo tick counter', async () => {
    const rt = runtime();
    const ids = new Set(Array.from({ length: 50 }, () => rt.deps.newId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id).not.toMatch(/^demo-id-/);
    }
    await rt.close();
  });

  it('uses PostgresLedger, PostgresParkStore and PostgresOutbox, so the proof outlives the process', async () => {
    const rt = runtime();
    expect(rt.deps.ledger).toBeInstanceOf(PostgresLedger);
    expect(rt.deps.parkStore).toBeInstanceOf(PostgresParkStore);
    expect(rt.outbox).toBeInstanceOf(PostgresOutbox);
    await rt.close();
  });

  it('uses GatewerkGate against the live API, never SimGate', async () => {
    const rt = runtime();
    expect(rt.deps.gate).toBeInstanceOf(GatewerkGate);
    expect(rt.deps.gate.constructor.name).not.toBe('SimGate');
    await rt.close();
  });

  it('points the gate callback at this deployment public URL', async () => {
    // vi.fn<typeof fetch>, not a bare vi.fn: a bare spy infers a ZERO-argument signature, which
    // makes mock.calls[0][1] a type error and quietly un-types the request body this test reads.
    // That exact shape is recorded in the master plan execution log.
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ id: 'rev_1' }), { status: 201 }),
    );
    const gate = new GatewerkGate({
      baseUrl: ENV['GATEWERK_BASE_URL']!, apiKey: 'k',
      callbackUrl: loadCeremonyConfig(ENV).data!.gatewerk.callbackUrl,
      templateSlug: loadCeremonyConfig(ENV).data!.gatewerk.templateSlug, fetchImpl,
    });
    await gate.submit({
      requestId: 'r1', runId: 'run1', title: 't',
      content: { to: 'a@b.io', subject: 's', body: 'b' },
      metadata: { paramsHash: 'h', stakesRuleId: 'rule' },
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.callback_url).toBe('https://agent.example.com/warrant/v1/gatewerk/review');
    // Restated here because the ceremony is where it would actually cost something (C6, spec 2.2).
    expect(body.oversight).toBe('blocking');
    expect(body).not.toHaveProperty('timeout');
  });

  it('separates the runtime pool from the admin pool, so DDL never runs as the app role', async () => {
    const rt = runtime();
    expect(rt.pool).not.toBe(rt.adminPool);
    await rt.close();
  });
});

describe('prod-deps: ceremony mode has no fallback', () => {
  const saved = { ...process.env };

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  it('with the ceremony off, getDeps stays on the Milestone A demo runtime', async () => {
    delete process.env['WARRANT_CEREMONY'];
    const { getDeps } = await import('../src/prod-deps.js');
    const deps = getDeps();
    expect(deps.publicKeyHex).toBe(generateKeyPair(DEMO_PRIVATE_KEY_HEX).publicKeyHex);
    expect(getDeps()).toBe(deps);
  });

  it('with the ceremony on and the config broken, getDeps THROWS rather than using demo deps', async () => {
    process.env['WARRANT_CEREMONY'] = '1';
    delete process.env['WARRANT_PRIVATE_KEY_HEX'];
    const { getDeps } = await import('../src/prod-deps.js');
    expect(() => getDeps()).toThrow(/ceremony configuration rejected/);
  });

  it('with the ceremony on and the DEMO key supplied, it still refuses to start', async () => {
    process.env['WARRANT_CEREMONY'] = '1';
    Object.assign(process.env, ENV, { WARRANT_PRIVATE_KEY_HEX: DEMO_PRIVATE_KEY_HEX });
    const { getDeps } = await import('../src/prod-deps.js');
    expect(() => getDeps()).toThrow(/published demo key/);
  });

  it('getCeremonyRuntime refuses to hand out a Postgres outbox when the ceremony is off', async () => {
    delete process.env['WARRANT_CEREMONY'];
    const { getCeremonyRuntime } = await import('../src/prod-deps.js');
    expect(() => getCeremonyRuntime()).toThrow(/ceremony_not_enabled/);
  });

  it('with a valid ceremony env, getDeps and getCeremonyRuntime share ONE deps object', async () => {
    Object.assign(process.env, ENV);
    const { getDeps, getCeremonyRuntime } = await import('../src/prod-deps.js');
    const rt = getCeremonyRuntime();
    expect(getDeps()).toBe(rt.deps);
    expect(getCeremonyRuntime()).toBe(rt);
    await rt.close();
  });
});
