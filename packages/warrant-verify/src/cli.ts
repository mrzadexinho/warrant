#!/usr/bin/env node
// This entrypoint is bundled by esbuild (see "build" in package.json), not compiled
// in place by tsc like the rest of this package. It is the one artifact in the
// product a third party runs OUTSIDE this monorepo, to check a certificate without
// trusting the operator, so it must not depend on workspace symlinks or a TS loader.
// @idriszade/warrant-core and @idriszade/warrant-ledger are tsx/vitest-only internal
// packages (main points at .ts source with .js-extension relative imports); a plain
// "node dist/cli.js" cannot resolve them unbundled. Library consumers of this package
// (warrant-eve, warrant-agent-outbound, ...) still import from ./src/index.ts under
// tsx/vitest as before; only this bin's build path changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPair } from '@idriszade/warrant-core';
import type { LedgerEntry } from '@idriszade/warrant-ledger';
import { verifyChain } from './chain.js';
import { exportDsse, verifyDsse } from './dsse.js';
import { replayRun } from './replay.js';
import { renderProofMarkdown } from './render.js';
import type { TrajectoryLeafSource } from './trajectory.js';

const USAGE =
  'Usage: warrant-verify <ledger.json> [--json] [--leaves <f>] [--dsse <out> --sign-key <hex>] [--verify-dsse <f> --key <hex>]\n' +
  '  --leaves <f>  JSON { "<requestId>": [{kind, ref, valueHash}, ...] }: the trajectory\n' +
  '                leaves, which live in the producer\'s store and never in the ledger.\n' +
  '                Without it an attested trajectory reports UNPROVEN, which is the truth:\n' +
  '                a verifier holding no leaves cannot reproduce the root.\n';

const args = process.argv.slice(2);
const ledgerFile = args[0];
if (!ledgerFile) { process.stderr.write(USAGE); process.exit(1); }

// A flag whose value is missing is a usage error, not an absent flag. This used to return
// args[i+1] unconditionally, so `--verify-dsse cert.json --key` (value omitted, or eaten by
// a shell expansion) yielded pubKey === undefined, the verify branch below was skipped
// entirely, and the tool fell through to printing a per-run proof report and exiting 0. The
// operator asked "is this certificate valid" and got a green exit for a different question,
// with a "Chain Verified: ✓" report on stdout to confirm the wrong answer. `--dsse` with no
// output path behaved the same way: no certificate written, no complaint, exit 0.
//
// A value starting with `--` is treated as missing too, since it is the next flag rather
// than this one's argument. A path that genuinely begins with `--` can be passed as ./--x.
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    process.stderr.write(`Error: ${n} requires a value\n` + USAGE);
    process.exit(1);
  }
  return v;
};

const jsonMode = args.includes('--json');
const leavesFile = flag('--leaves');
const dsseOut = flag('--dsse');
const signKey = flag('--sign-key');
const vDsse = flag('--verify-dsse');
const pubKey = flag('--key');

// --dsse requires --sign-key (fail closed, never a silent skip)
if (dsseOut !== undefined && signKey === undefined) {
  process.stderr.write('Error: --dsse requires --sign-key <privHex>\n' + USAGE);
  process.exit(1);
}

// --verify-dsse mode: verify the envelope AND the chain it carries, then exit.
//
// The signature alone is not verification. It proves the bytes were signed by the
// key holder; it says nothing about whether the ledger inside those bytes is
// internally consistent. This branch used to check only the signature and exit 0,
// so a third party running this bin got "DSSE valid" for a chain whose entry
// hashes did not match their contents: a tampered recipient verified clean. That
// is a fail-open in the one artifact whose entire purpose is to be checkable by
// someone who does not trust the operator.
//
// The branch is entered on --verify-dsse ALONE. It used to require --key to be present as
// well, so a missing key silently downgraded the run to the report path below instead of
// failing: a verification request that quietly became something else and still exited 0.
if (vDsse !== undefined) {
  if (pubKey === undefined) {
    process.stderr.write('Error: --verify-dsse requires --key <pubHex>\n' + USAGE);
    process.exit(1);
  }
  const r = verifyDsse(JSON.parse(readFileSync(vDsse, 'utf8')), pubKey);
  if (r.error) { process.stderr.write(`DSSE verify failed: ${r.error.message}\n`); process.exit(1); }
  const chain = verifyChain(r.data!);
  if (chain.error) {
    process.stderr.write(`DSSE verify failed: signature is valid but the chain it carries is broken: ${chain.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`DSSE valid, chain verified. Entries: ${r.data!.length}\n`);
  process.exit(0);
}

const entries = JSON.parse(readFileSync(ledgerFile, 'utf8')) as LedgerEntry[];

// The trajectory leaves. Refuse a malformed file rather than falling through with no leaf
// source: the operator asked "prove the inputs too" and a silent downgrade to UNPROVEN would
// answer a different question and still exit 0, which is the failure this file already carries
// three comments about.
let leaves: TrajectoryLeafSource | undefined;
if (leavesFile !== undefined) {
  const raw: unknown = JSON.parse(readFileSync(leavesFile, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    process.stderr.write('Error: --leaves must be a JSON object keyed by requestId\n' + USAGE);
    process.exit(1);
  }
  const byRequest = raw as Record<string, unknown>;
  leaves = {
    leavesFor: (requestId) => {
      const v = byRequest[requestId];
      return Array.isArray(v) ? (v as readonly unknown[]) : undefined;
    },
  };
}

// Emit a DSSE envelope covering the full chain (all runs), but ONLY over a chain
// that verifies. This used to run before the per-run reports below, so a broken
// ledger was signed and written to disk and THEN the tool exited 1 complaining
// about it: the operator's own tooling minted a permanently valid certificate over
// a ledger it was in the act of rejecting. Signing is an assertion, so it has to be
// gated on the assertion being true.
if (dsseOut !== undefined && signKey !== undefined) {
  const preChain = verifyChain(entries);
  if (preChain.error) {
    process.stderr.write(`Refusing to sign a broken chain: ${preChain.error.message}\n`);
    process.exit(1);
  }
  writeFileSync(dsseOut, JSON.stringify(exportDsse(entries, generateKeyPair(signKey)), null, 2));
}

// Loop over every unique runId found in the file and print one report per run
const runIds = [...new Set(entries.map((e) => e.runId))];
for (const runId of runIds) {
  // CLI entrypoint: live clock is allowed here (injected-clock rule applies to domain logic only)
  const r = replayRun(entries, runId, () => new Date(), { leaves });
  if (r.error) {
    process.stderr.write(`Verification failed (${runId}): ${r.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(
    jsonMode ? JSON.stringify(r.data, null, 2) + '\n' : renderProofMarkdown(r.data!) + '\n',
  );
  // Print the report either way, then refuse to call the run verified. The report is
  // the evidence and is worth having; the exit code is the verdict. A run whose
  // ledger records an action executing after a deny has an intact chain, so exiting
  // 0 here would tell a third party the run was clean while the document in their
  // hand says otherwise.
  if (r.data!.violations.length > 0) {
    process.stderr.write(
      `Authorization violations in ${runId}: ${r.data!.violations.map((v) => `${v.kind}(${v.requestId})`).join(', ')}\n`,
    );
    process.exitCode = 1;
  }
}
