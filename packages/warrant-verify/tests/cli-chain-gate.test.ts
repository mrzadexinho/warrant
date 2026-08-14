// The regression tests for a fail-open in the one artifact whose entire purpose is
// to be checkable by someone who does not trust the operator.
//
// `--verify-dsse` used to validate only the Ed25519 signature over the envelope and
// then exit 0. A signature proves the bytes were signed by the key holder; it says
// nothing about whether the ledger inside those bytes is internally consistent. So a
// certificate over a tampered chain verified clean: the recipient could be changed
// and the verifier still printed "DSSE valid".
//
// And `--dsse` wrote the certificate BEFORE the per-run verification loop, so the
// operator's own tooling signed a ledger it was in the act of rejecting: it printed
// "Chain integrity failure" and exited 1 with the certificate already on disk.
//
// Both are covered here, through the BUILT bin rather than the library, because the
// built bin is what a third party actually runs.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { generateKeyPair } from '@idriszade/warrant-core';

const BIN = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SEED = 'dd'.repeat(32);
const PUB = generateKeyPair(SEED).publicKeyHex;
const P = { kind: 'agent' as const, id: 'a' };

let dir: string;
let goodPath: string;
let tamperedPath: string;

function run(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error(`built bin missing at ${BIN}; run "pnpm build" first`);
  dir = mkdtempSync(join(tmpdir(), 'wv-chain-gate-'));
  const l = new MemoryLedger();
  await l.append({ runId: 'run-1', at: '2026-07-27T00:00:00.000Z', event: 'warrant.requested', principal: P, payload: { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' } });
  await l.append({ runId: 'run-1', at: '2026-07-27T00:00:01.000Z', event: 'policy.evaluated', principal: P, payload: { requestId: 'r1', ruleId: 'x', path: 'auto' } });
  const all = (await l.readAll()).data!;
  goodPath = join(dir, 'good.json');
  writeFileSync(goodPath, JSON.stringify(all, null, 2));

  // Change only the RECIPIENT. Every hash and prevHash is left untouched, which is
  // what makes this a chain-integrity question rather than a signature one.
  const t = JSON.parse(JSON.stringify(all)) as typeof all;
  (t[0]!.payload as Record<string, unknown>)['target'] = 'ceo@competitor.gov';
  tamperedPath = join(dir, 'tampered.json');
  writeFileSync(tamperedPath, JSON.stringify(t, null, 2));
});

describe('warrant-verify refuses to sign a chain it cannot verify', () => {
  it('writes NO certificate for a tampered ledger, and says why', () => {
    const out = join(dir, 'should-not-exist.json');
    const r = run([tamperedPath, '--dsse', out, '--sign-key', SEED]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Refusing to sign a broken chain/);
    // The file must be ABSENT, not merely unreferenced. Previously it was written
    // first and the failure reported afterwards, so a valid certificate over a
    // rejected ledger survived on disk.
    expect(existsSync(out)).toBe(false);
  });

  it('still signs a genuine ledger', () => {
    const out = join(dir, 'good-cert.json');
    const r = run([goodPath, '--dsse', out, '--sign-key', SEED]);
    expect(r.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});

describe('warrant-verify --verify-dsse checks the chain, not just the signature', () => {
  it('rejects a validly-signed certificate whose chain is broken', () => {
    // Build the certificate by signing the tampered entries directly, bypassing the
    // export gate above. This is the certificate a malicious or compromised operator
    // could hand over: the signature is genuine, the chain is not. Verification must
    // still fail, because the third party's trust rests on the chain and not on the
    // operator's good behaviour at export time.
    const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8'));
    const evil = join(dir, 'evil.json');
    // Sign via the library so the signature is unquestionably valid.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('../src/dsse.js').then(({ exportDsse }) => {
      writeFileSync(evil, JSON.stringify(exportDsse(tampered, generateKeyPair(SEED)), null, 2));
      const r = run(['/dev/null', '--verify-dsse', evil, '--key', PUB]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/signature is valid but the chain it carries is broken/);
      expect(r.out).not.toMatch(/DSSE valid/);
    });
  });

  it('accepts a genuine certificate and says the chain was verified', () => {
    const out = join(dir, 'genuine.json');
    run([goodPath, '--dsse', out, '--sign-key', SEED]);
    const r = run(['/dev/null', '--verify-dsse', out, '--key', PUB]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/chain verified/);
  });

  it('still rejects a genuine chain under the wrong key', () => {
    // The signature check must not have been weakened while adding the chain check.
    const out = join(dir, 'genuine2.json');
    run([goodPath, '--dsse', out, '--sign-key', SEED]);
    const wrong = generateKeyPair('ee'.repeat(32)).publicKeyHex;
    const r = run(['/dev/null', '--verify-dsse', out, '--key', wrong]);
    expect(r.code).toBe(1);
    // Status alone is not enough: without the early exit on r.error, verifyChain(null)
    // throws on .length and node exits 1 too. The message is what separates a
    // rejection from a crash, and this file's own tampered-ledger test already makes
    // that distinction one branch up.
    expect(r.err).toMatch(/DSSE verify failed/);
    expect(r.err).not.toMatch(/TypeError|at Object\./);
  });
});

describe('cleanup', () => {
  it('removes the temp dir', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
