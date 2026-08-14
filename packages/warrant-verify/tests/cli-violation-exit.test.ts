// The exit code is the verdict, and nothing was holding it.
//
// A mutation sweep deleted `process.exitCode = 1` from the authorization-violations
// branch of src/cli.ts and every test in every warrant package stayed green. The CLI
// still PRINTED the violations, on stderr and inside the report, so the defect is not
// invisible to a human reading the output. It is invisible to everything else: CI
// gates, `warrant-verify ledger.json && deploy`, a script that checks `$?`. A run whose
// ledger records an action executing after a deny would have exited 0.
//
// That is the same failure shape as the verifier that printed "DSSE valid" over a
// tampered chain, one layer out: the tool answers correctly and then reports success.
//
// Tests run the BUILT bin, because the exit code of the built bin is the thing a third
// party's shell actually reads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { LedgerEntry } from '@idriszade/warrant-ledger';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'dist/cli.js');
const P = { kind: 'agent' as const, id: 'a' };

let dir: string;

function bin(...args: string[]) {
  return spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
}

/** Builds a real, chain-valid run from the given events. Hashes are the ledger's. */
async function chainOf(runId: string, events: Array<[LedgerEntry['event'], unknown]>): Promise<LedgerEntry[]> {
  const l = new MemoryLedger();
  let t = 0;
  for (const [event, payload] of events) {
    const r = await l.append({
      runId, at: `2026-07-27T00:0${t++}:00.000Z`, event, principal: P, payload,
    });
    if (r.error) throw new Error(`fixture append failed: ${r.error.message}`);
  }
  return (await l.readAll()).data!;
}

function writeLedger(name: string, entries: LedgerEntry[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

beforeAll(() => {
  // Build here rather than rely on file order. warrant-verify's `test` script builds
  // first, but a test that executes dist/ and assumes somebody else built it is exactly
  // how a CLI change once got validated against a stale bundle.
  const build = spawnSync('pnpm', ['run', 'build'], { cwd: PKG_ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);
  dir = mkdtempSync(join(tmpdir(), 'wv-violation-exit-'));
}, 30_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('a run with authorization violations exits non-zero', () => {
  it('executed after a deny: exit 1, the report still printed, the reason on stderr', async () => {
    // The chain here is perfectly intact, which is the whole point: every entry links
    // and hashes correctly because the ledger faithfully recorded a governance
    // failure. Chain verification passes and the run is still not clean.
    const path = writeLedger('denied-then-executed.json', await chainOf('run-x', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ceo@competitor.gov' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'protected-audience', path: 'deny' }],
      ['warrant.denied', { requestId: 'r1', reason: 'policy_denied:protected-audience' }],
      ['action.executed', { requestId: 'r1', warrantId: 'w-ghost', nonce: 'n-1' }],
    ]));

    const r = bin(path);

    expect(r.status).toBe(1);
    // The report is the evidence and is worth having, so it must still be printed.
    // Asserting this separately means a change that suppressed the report to make the
    // exit code work would fail rather than look like a fix.
    expect(r.stdout).toContain('Warrant Run Proof');
    expect(r.stdout).toContain('AUTHORIZATION VIOLATIONS');
    expect(r.stderr).toContain('Authorization violations in run-x');
    expect(r.stderr).toContain('executed_after_deny');
    // Failing via the violations path, not via a crash that happens to exit 1.
    expect(r.stderr).not.toContain('Verification failed');
    expect(r.stderr).not.toMatch(/TypeError|at Object\./);
  });

  it('executed with no warrant in the chain: exit 1', async () => {
    // The second violation kind. Distinct from the first because policy APPROVED this
    // one; what is missing is any warrant.issued to authorize the execution.
    const path = writeLedger('no-warrant.json', await chainOf('run-y', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known-audience', path: 'auto' }],
      ['action.executed', { requestId: 'r1', warrantId: 'w-1', nonce: 'n-1' }],
    ]));

    const r = bin(path);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('executed_without_warrant');
  });

  it('--json mode fails the same way, because the exit code is not a rendering concern', async () => {
    const path = writeLedger('violation-json.json', await chainOf('run-z', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ceo@competitor.gov' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'protected-audience', path: 'deny' }],
      ['warrant.denied', { requestId: 'r1', reason: 'policy_denied:protected-audience' }],
      ['action.executed', { requestId: 'r1', warrantId: 'w-ghost', nonce: 'n-1' }],
    ]));

    const r = bin(path, '--json');

    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as { chainVerified: boolean; violations: Array<{ kind: string }> };
    // Both halves of the claim in one place: the chain really is verified, and the run
    // is still reported as not clean.
    expect(report.chainVerified).toBe(true);
    expect(report.violations.map((v) => v.kind)).toContain('executed_after_deny');
  });

  it('a clean run of the same shape exits 0, so the gate is not failing everything', async () => {
    const path = writeLedger('clean.json', await chainOf('run-ok', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known-audience', path: 'auto' }],
      ['warrant.issued', { requestId: 'r1', warrantId: 'w-1' }],
      ['action.executed', { requestId: 'r1', warrantId: 'w-1', nonce: 'n-1' }],
    ]));

    const r = bin(path);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Warrant Run Proof');
    expect(r.stdout).not.toContain('AUTHORIZATION');
    expect(r.stderr).toBe('');
  });

  it('one bad run among several fails the whole invocation', async () => {
    // The CLI loops over every runId in the file. A ledger holding one clean run and
    // one violating run must not exit 0 on the strength of the clean one, and both
    // reports must still be printed.
    const clean = await chainOf('run-ok', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known-audience', path: 'auto' }],
      ['warrant.issued', { requestId: 'r1', warrantId: 'w-1' }],
      ['action.executed', { requestId: 'r1', warrantId: 'w-1', nonce: 'n-1' }],
    ]);
    // Continue the SAME chain so seq stays contiguous across both runs in one file.
    const l = MemoryLedger.fromEntries(clean);
    for (const [event, payload] of [
      ['warrant.requested', { requestId: 'r2', actionKind: 'send_email', target: 'ceo@competitor.gov' }],
      ['policy.evaluated', { requestId: 'r2', ruleId: 'protected-audience', path: 'deny' }],
      ['warrant.denied', { requestId: 'r2', reason: 'policy_denied' }],
      ['action.executed', { requestId: 'r2', warrantId: 'w-ghost', nonce: 'n-2' }],
    ] as Array<[LedgerEntry['event'], unknown]>) {
      const a = await l.append({ runId: 'run-bad', at: '2026-07-27T01:00:00.000Z', event, principal: P, payload });
      expect(a.error).toBeNull();
    }
    const path = writeLedger('mixed.json', (await l.readAll()).data!);

    const r = bin(path);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('run-ok');
    expect(r.stdout).toContain('run-bad');
    expect(r.stderr).toContain('Authorization violations in run-bad');
    expect(r.stderr).not.toContain('Authorization violations in run-ok');
  });
});

describe('the CLI fails with its own message, not with a stack trace', () => {
  it('no arguments at all prints usage and exits 1', async () => {
    // Without the guard, readFileSync(undefined) throws and node exits 1 with a stack
    // trace. The exit code is the same, which is why asserting only on status would
    // have let this through; the usage text is the whole content of the guard.
    const r = bin();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: warrant-verify');
    expect(r.stderr).not.toMatch(/TypeError|ENOENT|at Object\./);
  });

  it('a certificate that fails signature verification reports why', async () => {
    // Same shape one branch down: without the early exit, r.data is null and
    // verifyChain(null) throws on .length. Node still exits 1, so the existing
    // wrong-key test could not see it. The message is what distinguishes a rejection
    // from a crash.
    const entries = await chainOf('run-ok', [
      ['warrant.requested', { requestId: 'r1', actionKind: 'send_email', target: 'ok@acme.com' }],
      ['policy.evaluated', { requestId: 'r1', ruleId: 'known-audience', path: 'auto' }],
    ]);
    const ledgerPath = writeLedger('sig-ledger.json', entries);
    const cert = join(dir, 'sig-cert.json');
    expect(bin(ledgerPath, '--dsse', cert, '--sign-key', 'a'.repeat(64)).status).toBe(0);
    expect(existsSync(cert)).toBe(true);

    const { generateKeyPair } = await import('@idriszade/warrant-core');
    const wrongPub = generateKeyPair('b'.repeat(64)).publicKeyHex;
    const r = bin(ledgerPath, '--verify-dsse', cert, '--key', wrongPub);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DSSE verify failed');
    expect(r.stderr).not.toMatch(/TypeError|at Object\./);
    expect(r.stdout).not.toContain('DSSE valid');
  });
});
