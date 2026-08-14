import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { entryHash, GENESIS_PREV_HASH } from '@idriszade/warrant-ledger';

const PRIV = 'c'.repeat(64);
const KEYS = generateKeyPair(PRIV);
const P = { kind: 'agent' as const, id: 'a' };
// Resolve CLI path relative to this test file: works regardless of cwd
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');

// A LEGITIMATE run: requested, issued, executed. The warrant.issued entry is not
// decoration. It used to be omitted, so the fixture described an action executing
// with no warrant anywhere in the chain, which is precisely the governance failure
// this product exists to detect: buildExecute only appends action.executed after
// verifying a warrant it read from the ledger, so that ledger cannot occur in
// production. replayRun now reports it as an executed_without_warrant violation and
// the CLI exits non-zero, which is why the fixture had to become realistic.
function mkEntries(runId = 'r1'): LedgerEntry[] {
  const b1 = { seq: 1, prevHash: GENESIS_PREV_HASH, runId,
    at: '2026-07-16T00:00:00Z', event: 'warrant.requested' as const, principal: P,
    payload: { requestId: 'req-1', actionKind: 'send_email', target: 'x@y.com' } };
  const h1 = entryHash(b1);
  const b2 = { seq: 2, prevHash: h1, runId, at: '2026-07-16T00:00:30Z',
    event: 'warrant.issued' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1' } };
  const h2 = entryHash(b2);
  const b3 = { seq: 3, prevHash: h2, runId, at: '2026-07-16T00:01:00Z',
    event: 'action.executed' as const, principal: P,
    payload: { requestId: 'req-1', warrantId: 'w-1', nonce: 'n-1' } };
  return [{ ...b1, hash: h1 }, { ...b2, hash: h2 }, { ...b3, hash: entryHash(b3) }];
}

/** Build a two-run ledger with a single global chain (seq continues across runs). */
function mkTwoRunEntries(): LedgerEntry[] {
  const run1 = mkEntries('run-A');
  // run-B entries continue the global seq + chain from the end of run-A
  const lastHash = run1[run1.length - 1]!.hash;
  // seq continues the global chain, so it follows run-A's length rather than a
  // hardcoded 3: run-A grew when warrant.issued was added to make it a legitimate run.
  const b3 = { seq: run1.length + 1, prevHash: lastHash, runId: 'run-B',
    at: '2026-07-16T01:00:00Z', event: 'warrant.requested' as const, principal: P,
    payload: { requestId: 'req-2', actionKind: 'draft_email', target: 'z@w.com' } };
  const h3 = entryHash(b3);
  return [...run1, { ...b3, hash: h3 }];
}

let tmp: string;
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// Package root: resolves correctly from any cwd
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function cli(ledger: string, ...extra: string[]) {
  return spawnSync('node', ['--import', 'tsx/esm', CLI, ledger, ...extra],
    { encoding: 'utf8', cwd: PKG_ROOT });
}

describe('warrant-verify CLI', () => {
  it('markdown output for valid ledger', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv-'));
    const l = join(tmp, 'l.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = cli(l);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Warrant Run Proof');
  });
  it('--json prints parseable RunReport', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv2-'));
    const l = join(tmp, 'l.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = cli(l, '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).chainVerified).toBe(true);
  });
  it('--dsse writes envelope with correct keyid', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv3-'));
    const l = join(tmp, 'l.json');
    const out = join(tmp, 'out.dsse.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    expect(cli(l, '--dsse', out, '--sign-key', PRIV).status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const env = JSON.parse(readFileSync(out, 'utf8'));
    expect(env.signatures[0].keyid).toBe(KEYS.publicKeyHex);
  });
  it('--dsse without --sign-key exits 1 with usage error (fail closed)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv5-'));
    const l = join(tmp, 'l.json');
    const out = join(tmp, 'out.dsse.json');
    writeFileSync(l, JSON.stringify(mkEntries()));
    const r = cli(l, '--dsse', out); // no --sign-key
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--sign-key/);
  });
  it('exits 1 on tampered ledger', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv4-'));
    const l = join(tmp, 'l.json');
    const entries = mkEntries();
    entries[0]!.payload = { tampered: true };
    writeFileSync(l, JSON.stringify(entries));
    expect(cli(l).status).toBe(1);
  });
  it('multi-run ledger prints one report per runId', () => {
    tmp = mkdtempSync(join(tmpdir(), 'wv6-'));
    const l = join(tmp, 'l.json');
    writeFileSync(l, JSON.stringify(mkTwoRunEntries()));
    const r = cli(l);
    expect(r.status).toBe(0);
    // Both run IDs must appear in stdout
    expect(r.stdout).toContain('run-A');
    expect(r.stdout).toContain('run-B');
  });
});
