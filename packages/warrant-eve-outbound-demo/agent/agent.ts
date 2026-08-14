// Static deployment artifact: shows the production eve agent shape.
// Not executed in tests; logic is driven in-process via src/build.ts.
import { defineAgent } from 'eve';
import type { AgentDefinition } from 'eve';
import { isCeremonyEnabled, loadCeremonyConfig } from '../src/config.js';
import { buildCeremonyModel } from '../src/model.js';

// `instructions` is NOT a defineAgent key in eve 0.25.2: instructions are discovered by path
// from `agent/instructions.md`. Declaring it fails config load with `Unknown key "instructions"`.
//
// Pass 2 model knob (design spec section 9). `model` accepts an AI Gateway id string OR an AI SDK
// LanguageModel instance (eve 0.25.2, PublicAgentStaticModelDefinition = string | LanguageModel), so
// the ceremony hands it a real @ai-sdk/openai handle built from OPENAI_API_KEY.
//
// modelContextWindowTokens is set ONLY on the ceremony branch, and it is required there rather than
// tidy: a LanguageModel instance carries no AI Gateway metadata, so eve has no context window to
// read and compaction would have nothing to trigger on.
//
// Reading env in this file is sanctioned (agent/*.ts is an entrypoint). Config errors throw here for
// the same reason they throw in prod-deps.ts: a ceremony that starts on a fallback is worse than one
// that does not start.
function ceremonyModel() {
  const cfg = loadCeremonyConfig();
  if (cfg.error) throw new Error(cfg.error.message);
  return buildCeremonyModel(cfg.data);
}

// Annotated because the ceremony branch's inferred type names a transitively installed
// @ai-sdk/provider that tsc cannot write down from here (TS2742). defineAgent still does the
// exact-shape check at each call site above, so an unknown key is still a compile error.
const agent: AgentDefinition = isCeremonyEnabled()
  ? defineAgent({ model: ceremonyModel(), modelContextWindowTokens: 400_000 })
  : defineAgent({ model: 'anthropic/claude-sonnet-5' });

export default agent;
