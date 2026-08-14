import type { PolicyDoc } from '@idriszade/warrant-policy';
import { loadPolicy } from '@idriszade/warrant-policy';
import { GTM_DEFAULT_YAML } from './gtm-default-yaml.js';

/**
 * Loads the bundled GTM policy.
 *
 * The YAML is inlined rather than read from disk (contract C12): `readFileSync` of a relative
 * asset does not survive eve's bundler, and because `send_email.ts` calls `buildDeps()` at module
 * scope, the failure surfaced at compile time as an ENOENT under `.cache/eve/assets/`.
 * `tests/policy-bundling.test.ts` guards the inlined copy against drifting from the asset.
 */
export function defaultGtmPolicy(): { doc: PolicyDoc; hash: string } {
  const result = loadPolicy(GTM_DEFAULT_YAML);
  if (result.error) {
    throw new Error(`Failed to load bundled gtm-default.yaml: ${result.error.message}`);
  }
  return result.data;
}
