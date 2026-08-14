// Spawns the INSTALLED bin (dist/cli.js) with plain `node`, never tsx. tests/cli.test.ts
// spawns `node --import tsx/esm src/cli.ts`, which is exactly why bin -> ./src/cli.js (a
// file the package never built) went unnoticed: tsx never touches dist/, so the missing
// build step had no test surface. This file builds first, then exercises the compiled,
// esbuild-bundled artifact the same way a third party running it outside this monorepo
// would: no workspace node_modules, no TS loader, nothing but plain node and the file.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';

const PRIV = 'd'.repeat(64);
const KEYS = generateKeyPair(PRIV);
const P = { kind: 'agent' as const, id: 'a' };
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'dist/cli.js');

function mkEntries(): LedgerEntry[] {
  const b1 = {
    seq: 1, prevHash: GENESIS_PREV_HASH, runId: 'r1', at: '2026-07-16T00:00:00Z',
    event: 'warrant.requested' as const, principal: P,
    payload: { requestId: 'req-1', actionKind: 'send_email', target: 'x@y.com' },
  };
  const h1 = entryHash(b1);
  // warrant.issued is required for this to be a LEGITIMATE run. Without it the
  // fixture describes an action executing with no warrant in the chain, which
  // replayRun now reports as an executed_without_warrant violation and the CLI
  // exits non-zero for. buildExecute only appends action.executed after verifying a
  // warrant read from the ledger, so that shape cannot occur in production.
  const b2 = {
    seq: 2, prevHash: h1, runId: 'r1', at: '2026-07-16T00:00:30Z',
    event: 'warrant.issued' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1' },
  };
  const h2 = entryHash(b2);
  const b3 = {
    seq: 3, prevHash: h2, runId: 'r1', at: '2026-07-16T00:01:00Z',
    event: 'action.executed' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1', nonce: 'n-1' },
  };
  return [{ ...b1, hash: h1 }, { ...b2, hash: h2 }, { ...b3, hash: entryHash(b3) }];
}

beforeAll(() => {
  // Bundled with esbuild, not tsc: dist/cli.js must be self-contained (no bare specifiers
  // resolving into workspace-symlinked, tsx-only sibling packages). See the comment above
  // the shebang in src/cli.ts for why. Build here rather than assume it already ran, and
  // fail with a clear pointer instead of letting a missing dist/ silently no-op the suite.
  const build = spawnSync('pnpm', ['run', 'build'], { cwd: PKG_ROOT, encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(
      `build failed, run "pnpm build" in packages/warrant-verify to see the full output:\n${build.stdout}\n${build.stderr}`,
    );
  }
}, 30_000);

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function bin(...args: string[]) {
  return spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
}

describe('warrant-verify installed bin (dist/cli.js)', () => {
  it('has the built artifact with the shebang intact', () => {
    expect(existsSync(BIN)).toBe(true);
    expect(readFileSync(BIN, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('valid ledger prints a report and exits 0', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv-bin-report-'));
    const l = join(tmp, 'l.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = bin(l);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Warrant Run Proof');
  });

  it('--dsse writes a file, --verify-dsse on it exits 0', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv-bin-dsse-'));
    const l = join(tmp, 'l.json');
    const out = join(tmp, 'out.dsse.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const write = bin(l, '--dsse', out, '--sign-key', PRIV);
    expect(write.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const verify = bin('--verify-dsse', out, '--key', KEYS.publicKeyHex);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('DSSE valid');
  });

  it('--dsse without --sign-key exits 1 with the usage error (fail closed)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv-bin-nokey-'));
    const l = join(tmp, 'l.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = bin(l, '--dsse', join(tmp, 'out.dsse.json'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--sign-key/);
  });

  // A verification request that quietly turns into a different, successful command is the
  // same fail-open shape as a signature check that skipped the chain: the operator gets an
  // exit 0 and a "Chain Verified: ✓" report for a question nobody answered. Each case here
  // asserts the report was NOT printed, not merely that the exit code was non-zero, because
  // the report on stdout is the thing that misleads a human.
  describe('a flag whose value is missing fails closed rather than changing the question', () => {
    const missingValue: Array<[string, (l: string, cert: string) => string[]]> = [
      ['--verify-dsse with --key present but valueless', (l, c) => [l, '--verify-dsse', c, '--key']],
      ['--verify-dsse with no --key at all', (l, c) => [l, '--verify-dsse', c]],
      ['--verify-dsse itself valueless', (l) => [l, '--verify-dsse']],
      ['--key followed by the next flag rather than a value', (l, c) => [l, '--verify-dsse', c, '--key', '--json']],
      ['--dsse with no output path', (l) => [l, '--dsse']],
      ['--sign-key present but valueless', (l, c) => [l, '--dsse', c, '--sign-key']],
    ];

    for (const [label, mkArgs] of missingValue) {
      it(`${label} exits 1 and prints no proof report`, () => {
        tmp = mkdtempSync(join(tmpdir(), 'wv-bin-missing-'));
        const l = join(tmp, 'l.json');
        const cert = join(tmp, 'cert.json');
        writeFileSync(l, JSON.stringify(mkEntries()));
        expect(bin(l, '--dsse', cert, '--sign-key', PRIV).status).toBe(0);

        const r = bin(...mkArgs(l, cert));
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/requires/);
        expect(r.stdout).not.toContain('Warrant Run Proof');
        expect(r.stdout).not.toContain('DSSE valid');
      });
    }

    it('the same invocations with their values present still succeed', () => {
      // The positive control. A parser tightened into rejecting every flag would satisfy
      // all six assertions above and break the tool completely.
      tmp = mkdtempSync(join(tmpdir(), 'wv-bin-present-'));
      const l = join(tmp, 'l.json');
      const cert = join(tmp, 'cert.json');
      writeFileSync(l, JSON.stringify(mkEntries()));
      expect(bin(l, '--dsse', cert, '--sign-key', PRIV).status).toBe(0);
      expect(existsSync(cert)).toBe(true);

      const v = bin(l, '--verify-dsse', cert, '--key', KEYS.publicKeyHex);
      expect(v.status).toBe(0);
      expect(v.stdout).toContain('DSSE valid');

      // --json still parses as a valueless boolean flag and is not mistaken for a value.
      const j = bin(l, '--json');
      expect(j.status).toBe(0);
      expect(JSON.parse(j.stdout).chainVerified).toBe(true);
    });
  });

  it('exits 1 on a tampered ledger, rejected by chain verification (not a crash)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv-bin-tamper-'));
    const l = join(tmp, 'l.json');
    const entries = mkEntries();
    entries[0]!.payload = { tampered: true };
    writeFileSync(l, JSON.stringify(entries));
    const r = bin(l);
    expect(r.status).toBe(1);
    // Must fail via the CLI's own "Verification failed" path, not merely exit non-zero.
    // A crash (e.g. ERR_MODULE_NOT_FOUND from an unbundled dependency) also exits 1, and
    // asserting on status alone would let that masquerade as a correct rejection.
    expect(r.stderr).toContain('Verification failed');
    expect(r.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('is genuinely self-contained: runs from a copy outside this workspace, with no ancestor node_modules', () => {
    // The bundle is the one artifact a third party runs without cloning the monorepo, so
    // prove it works with nothing but the file itself: copy it into an isolated tmpdir
    // (macOS/Linux $TMPDIR has no @idriszade packages above it) and spawn it from there.
    const outside = mkdtempSync(join(tmpdir(), 'wv-bin-outside-'));
    tmp = outside;
    const copiedBin = join(outside, 'cli.js');
    copyFileSync(BIN, copiedBin);
    const l = join(outside, 'l.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = spawnSync('node', [copiedBin, l], { encoding: 'utf8', cwd: outside });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Warrant Run Proof');
  });
});

// The trajectory leaves never enter the ledger, so --leaves is the ONLY way a third party who
// does not trust the operator can check them. An unexercised flag on this bin is how three of
// the fail-open bugs commented in src/cli.ts got in.
describe('warrant-verify --leaves', () => {
  // Conformance vector 1: one observation leaf. Its root is the leaf. See tests/trajectory.test.ts.
  const LEAF = { kind: 'observation', ref: 'obs-1', valueHash: 'a'.repeat(64) };
  const ROOT = '8325e200ff9cabf22e06d42bab724d478d6a69612b198f786fa03c45228c2cf3';

  function attestedEntries(): LedgerEntry[] {
    const items = [
      { event: 'trajectory.attested' as const, payload: { requestId: 'req-1', digestVersion: 1, algo: 'sha256', leafCount: 1, inputsRoot: ROOT } },
      { event: 'warrant.requested' as const, payload: { requestId: 'req-1', actionKind: 'send_email', target: 'x@y.com', context: { entityId: 'e-1', inputsRoot: ROOT } } },
      { event: 'warrant.issued' as const, payload: { requestId: 'req-1', warrantId: 'w-1' } },
      { event: 'action.executed' as const, payload: { requestId: 'req-1', warrantId: 'w-1', nonce: 'n-1' } },
    ];
    const out: LedgerEntry[] = [];
    let prev = GENESIS_PREV_HASH;
    for (let i = 0; i < items.length; i++) {
      const base = { seq: i + 1, prevHash: prev, runId: 'r1', at: '2026-07-16T00:00:00Z', principal: P, ...items[i]! };
      const hash = entryHash(base);
      out.push({ ...base, hash });
      prev = hash;
    }
    return out;
  }

  function fixture(leafSets?: Record<string, unknown>) {
    tmp = mkdtempSync(join(tmpdir(), 'wv-leaves-'));
    const ledger = join(tmp, 'l.json');
    writeFileSync(ledger, JSON.stringify(attestedEntries()));
    if (leafSets === undefined) return { ledger, leaves: undefined };
    const leaves = join(tmp, 'leaves.json');
    writeFileSync(leaves, JSON.stringify(leafSets));
    return { ledger, leaves };
  }

  it('without --leaves the trajectory reads UNPROVEN, and the run is still clean', () => {
    const { ledger } = fixture();
    const r = bin(ledger);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('UNPROVEN');
    expect(r.stdout).toContain('| trajectory proven | 0 |');
  });

  it('with matching leaves the inputs are proven', () => {
    const { ledger, leaves } = fixture({ 'req-1': [LEAF] });
    const r = bin(ledger, '--leaves', leaves!);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('inputs proven');
    expect(r.stdout).toContain('| trajectory proven | 1 |');
    expect(r.stdout).not.toContain('UNPROVEN');
  });

  it('leaves that fold to another root exit 1: two documents that cannot both be true', () => {
    const { ledger, leaves } = fixture({ 'req-1': [{ ...LEAF, ref: 'obs-swapped' }] });
    const r = bin(ledger, '--leaves', leaves!);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('trajectory_leaves_mismatch');
    // The report still prints: the exit code is the verdict, the document is the evidence.
    expect(r.stdout).toContain('UNPROVEN');
  });

  it('a --leaves file that is not an object keyed by requestId exits 1 rather than silently proving nothing', () => {
    const { ledger, leaves } = fixture([LEAF] as unknown as Record<string, unknown>);
    const r = bin(ledger, '--leaves', leaves!);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--leaves must be a JSON object');
    expect(r.stdout).not.toContain('Warrant Run Proof');
  });

  it('--leaves with no value exits 1 and prints no proof report', () => {
    const { ledger } = fixture();
    const r = bin(ledger, '--leaves');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--leaves requires a value');
    expect(r.stdout).not.toContain('Warrant Run Proof');
  });
});
