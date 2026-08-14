/**
 * Vendor-blindness, enforced rather than asserted.
 *
 * "One guard, many actuators" only holds if the guard cannot learn what an actuator is. A
 * comment saying so decays; these tests fail the moment someone reaches for a vendor SDK or a
 * domain type to make one caller's life easier. That is the whole point: the pressure to
 * special-case the first awkward actuator is real, and this is what refuses it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG_ROOT, 'src');

const srcFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
const srcText = srcFiles.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

describe('the guard depends on nothing vendor-specific', () => {
  it('declares exactly the four dependencies the sequence needs', () => {
    // Pinned as an exact set, not a "does not contain" check. A denylist only catches the
    // vendors someone thought of; this catches the next one too.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@idriszade/core',        // Result
      '@idriszade/warrant-core', // verifyWarrant, paramsHash, the Warrant type
      '@idriszade/warrant-ledger', // the Ledger interface
      'zod',                    // the actuator's schema type, never a schema of its own
    ]);
  });

  it('names no vendor, transport, or domain anywhere in src', () => {
    // Substring search over source rather than over imports: a vendor can arrive as a string
    // literal, a field name, or a comment that quietly becomes a special case.
    const forbidden = [
      'email', 'smtp', 'nodemailer', 'resend', 'mailgun', 'sendgrid',
      'crm', 'hubspot', 'salesforce', 'slack', 'webhook',
      'subject', 'recipient', 'outbox',
    ];
    const found = forbidden.filter((w) => srcText.toLowerCase().includes(w));
    expect(found).toEqual([]);
  });

  it('defines no schema of its own: the actuator owns the shape', () => {
    // `z.object(`, `z.string(` etc. would mean the guard had an opinion about params. It takes
    // a ZodType and never constructs one.
    expect(srcText).not.toMatch(/\bz\.\w+\(/);
    expect(srcText).toContain('ZodType');
  });

  it('performs no I/O of its own beyond the injected ledger', () => {
    // No fs, no fetch, no clock. `now` is injected; the ledger is injected; the effect is the
    // caller's closure. Anything else here would be a side effect the certificate cannot see.
    expect(srcText).not.toMatch(/from 'node:(fs|http|https|net|child_process)/);
    expect(srcText).not.toMatch(/\bfetch\(|new Date\(\)|Date\.now\(\)|Math\.random\(\)/);
  });
});
