/**
 * Task 0 / contract C12: the policy pack must not read from disk.
 *
 * `defaultGtmPolicy()` used to load its YAML via
 * `readFileSync(new URL('../assets/gtm-default.yaml', import.meta.url))`, which does not survive
 * eve's bundler: the agent died at compile with ENOENT on `.cache/eve/assets/gtm-default.yaml`.
 * `agent/tools/send_email.ts` calls `buildDeps()` at module scope, so it fired during `eve info`
 * and `eve dev`, not merely at runtime.
 *
 * The YAML is now inlined as `GTM_DEFAULT_YAML`. `assets/gtm-default.yaml` remains the
 * human-authored source of truth, and the drift test below is what stops the two copies from
 * diverging silently. Reading the asset from disk is fine HERE, in a test, where there is no bundler.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GTM_DEFAULT_YAML } from '../src/gtm-default-yaml.js';
import { defaultGtmPolicy } from '../src/policy.js';

const assetPath = fileURLToPath(new URL('../assets/gtm-default.yaml', import.meta.url));

describe('C12: policy pack is bundler-safe', () => {
  it('inlined GTM_DEFAULT_YAML is byte-identical to assets/gtm-default.yaml', () => {
    const onDisk = readFileSync(assetPath, 'utf-8');
    expect(GTM_DEFAULT_YAML).toBe(onDisk);
  });

  it('no module in src/ resolves a packaged asset relative to its own module URL', () => {
    // The precise failure mode is reading a file that SHIPS WITH the package by resolving against
    // `import.meta.url` (or `__dirname`): the bundler rewrites module layout, so the path no longer
    // exists. Using `node:fs`/`node:path` on an INJECTED path is fine and bundles correctly, which
    // is why `executor.ts` writing to `deps.outboxDir` is not a violation. Guard the fragile
    // pattern, not filesystem access in general.
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(`${srcDir}/${name}`, 'utf-8');
      if (/import\.meta\.url|__dirname/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('defaultGtmPolicy() parses the inlined YAML and keeps its shape', () => {
    const { doc, hash } = defaultGtmPolicy();
    expect(doc.version).toBe('0.1.0');
    expect(doc.defaults.path).toBe('deny');
    expect(doc.stakes.map((s) => s.id)).toEqual([
      'draft-for-review',
      'reply-existing-thread',
      'cold-email-hiring-manager',
    ]);
    expect(doc.protectedAudiences).toEqual(['*@*.gov', 'press@*']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaultGtmPolicy() is stable across calls (same hash)', () => {
    expect(defaultGtmPolicy().hash).toBe(defaultGtmPolicy().hash);
  });
});
