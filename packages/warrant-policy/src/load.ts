import { parse as parseYaml } from 'yaml';
import type { Result } from '@idriszade/core';
import { ok, err } from '@idriszade/core';
import { sha256Hex, canonicalJson } from '@idriszade/warrant-core';
import type { WarrantError } from '@idriszade/warrant-core';
import { PolicyDocSchema } from './schema.js';
import type { PolicyDoc } from './schema.js';

export function loadPolicy(
  yamlText: string,
): Result<{ doc: PolicyDoc; hash: string }, WarrantError> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err({
      type: 'validation',
      code: 'policy_parse_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const parsed = PolicyDocSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      type: 'validation',
      code: 'policy_schema_invalid',
      message: parsed.error.message,
    });
  }
  const doc = parsed.data;

  // A cap must name an actionKind some stakes rule mentions.
  //
  // **`strictObject` cannot reach inside a record, and `caps.perPrincipalDaily` is one**, so
  // `send_emails` for `send_email` loads clean, and `evaluate.ts` reads an absent cap as
  // *uncapped*. Unknown keys are refused everywhere else a key is declared; this closes the same
  // hole in the one place keys are open by construction.
  //
  // **Refusing is safe because such a cap is necessarily dead config**, which is what makes this a
  // tightening rather than a policy judgement: an `actionKind` no stakes rule matches already hits
  // `default-deny`, so a cap on it could never have limited anything. A document that loses this
  // check loses nothing it was doing; a document that trips it had a typo or a rule it forgot to
  // write, and both are worth stopping at load rather than discovering as an uncapped principal.
  const declaredKinds = new Set(doc.stakes.map((r) => r.match.actionKind));
  const orphanedCaps = Object.keys(doc.caps.perPrincipalDaily).filter((k) => !declaredKinds.has(k));
  if (orphanedCaps.length > 0) {
    return err({
      type: 'validation',
      code: 'policy_schema_invalid',
      message:
        `caps.perPrincipalDaily names actionKind(s) no stakes rule mentions: ${orphanedCaps.join(', ')}. ` +
        `An unmatched actionKind already denies by default, so such a cap limits nothing: this is ` +
        `usually a misspelt key silently leaving the real action uncapped.`,
    });
  }

  const hash = sha256Hex(canonicalJson(doc));
  return ok({ doc, hash });
}
