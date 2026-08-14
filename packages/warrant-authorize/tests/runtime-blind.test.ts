/**
 * Runtime-blindness, enforced rather than asserted.
 *
 * "One request path, many runtimes" only holds if this package cannot learn what a runtime is.
 * A comment saying so decays; these tests fail the moment someone reaches for an agent
 * framework's types, or a Gate, to make one caller's life easier. That is the whole point: the
 * pressure to special-case the first awkward adapter is real, and this is what refuses it.
 *
 * Modelled on warrant-guard's `vendor-blind.test.ts`, with one difference that matters. The
 * guard scans by substring; that cannot work here, because the most important forbidden word is
 * three letters long and a substring search for it matches evaluate, event, review, never,
 * level and however, so it would fail on this package's own source and prove nothing. Every scan
 * below is therefore word-boundary anchored.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG_ROOT, 'src');

const srcFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const srcText = srcFiles.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

describe('the authorization seam depends on nothing runtime-specific', () => {
  it('declares exactly the four dependencies the sequence needs', () => {
    // Pinned as an exact set, not a "does not contain" check. A denylist only catches the
    // runtime somebody thought of; this catches the next one too. The two absences that carry
    // the design are asserted separately below, because an exact-set failure reads as "someone
    // added a dep" and those two would mean something much more specific.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@idriszade/core', // Result
      '@idriszade/warrant-core', // issueWarrant, canonicalJson, sha256Hex, the types
      '@idriszade/warrant-ledger', // the Ledger interface
      '@idriszade/warrant-policy', // evaluate, PolicyDoc
    ]);
  });

  it('depends on no Gate and on no agent runtime, in any dependency field', () => {
    // The two absences the header argues for, named so a failure says which line of the
    // argument was abandoned. Checked across every dependency field, not just `dependencies`:
    // arriving as a peer or a dev dep would couple the package just as firmly.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | unknown
    >;
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const declared = fields.flatMap((f) =>
      typeof pkg[f] === 'object' && pkg[f] !== null ? Object.keys(pkg[f] as Record<string, string>) : [],
    );
    expect(declared).not.toContain('@idriszade/warrant-gatewerk');
    // The agent runtime is declared as a bare `eve` peer dependency where it IS used, so an
    // exact-name check is the honest one rather than a fuzzy match over package names.
    expect(declared).not.toContain('eve');
  });

  it('imports no Gate and no agent runtime anywhere in src', () => {
    // The package.json set can be satisfied while a source file imports something transitively
    // reachable. This reads the import statements themselves.
    expect(srcText).not.toMatch(/from\s+'@idriszade\/warrant-gatewerk/);
    expect(srcText).not.toMatch(/from\s+'eve(\/|')/);
  });

  it('names no runtime or domain word anywhere in src', () => {
    // Word-boundary rather than substring, deliberately: see the header. A runtime can arrive
    // as a field name, a string literal, or a comment that quietly becomes a special case, so
    // the scan covers source and comments alike.
    const forbidden = [
      // the agent runtime this was lifted out of, and its vocabulary
      'eve', 'callId', 'toolInput', 'session', 'ApprovalContext',
      // the domain words warrant-guard already forbids, kept identical on purpose
      'email', 'smtp', 'nodemailer', 'resend', 'mailgun', 'sendgrid',
      'crm', 'hubspot', 'salesforce', 'slack', 'webhook',
      'subject', 'recipient', 'outbox',
    ];
    const found = forbidden.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(srcText));
    expect(found).toEqual([]);
  });

  it('the word-boundary scan is not vacuous', () => {
    // A regex bug that matched nothing would make the test above pass forever. These are the
    // exact strings that a substring scan would have tripped over, and they must NOT match;
    // the standalone words must.
    const hits = (w: string, text: string): boolean => new RegExp(`\\b${w}\\b`, 'i').test(text);
    expect(hits('eve', 'evaluate event review never level however')).toBe(false);
    expect(hits('eve', "import type { X } from 'eve/tools'")).toBe(true);
    expect(hits('session', 'const runId = ctx.session.id;')).toBe(true);
    expect(hits('callId', 'const id = ctx.callId;')).toBe(true);
    // And the property that matters most: the real source contains the near-misses.
    expect(/\bevaluate\b/.test(srcText)).toBe(true);
    expect(/\breview\b/i.test(srcText)).toBe(true);
  });

  it('defines no schema and performs no I/O of its own beyond the injected ledger', () => {
    // No clock, no id source, no network. `now` and `newId` are injected and the ledger is
    // injected. Anything else here would be a side effect the certificate cannot see, and a
    // non-injected clock or id would break the replayability the whole artifact rests on.
    expect(srcText).not.toMatch(/from 'node:(fs|http|https|net|child_process|crypto)/);
    expect(srcText).not.toMatch(/\bfetch\(|new Date\(\)|Date\.now\(\)|Math\.random\(\)|randomUUID/);
  });
});
