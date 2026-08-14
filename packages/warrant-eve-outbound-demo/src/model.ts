// model.ts: the design spec section 9 model knob. Milestone A drove the approval and execute
// callbacks directly with no model at all; the ceremony puts a real one behind them.
//
// OpenAI is a deliberate choice, not a convenience. The Claude-SDK reference runtime
// (warrant-agent-outbound) already proves the governed loop under Anthropic. Running the SAME
// policy, the SAME ledger, the SAME certificate and the SAME verifier against a different model
// vendor is evidence that warrant's neutrality claim covers models as well as frameworks. It is a
// strengthening of the argument, which is why it is worth an extra dependency.
//
// Pure: no process.env here. src/config.ts reads the environment; this takes the result.
import { createOpenAI } from '@ai-sdk/openai';

export interface CeremonyModelConfig {
  openaiApiKey: string;
  model: string;
}

// Named explicitly rather than inferred. The inferred type is LanguageModelV3 from a transitively
// installed @ai-sdk/provider, which tsc cannot write down from here (TS2742), and adding that
// package as a direct dependency just to name a return type would pin a second copy of a version
// eve already resolves. See the execution log entry about unpinned dependency adds.
export type CeremonyModel = ReturnType<ReturnType<typeof createOpenAI>>;

export function buildCeremonyModel(cfg: CeremonyModelConfig): CeremonyModel {
  // Explicit apiKey rather than the provider's ambient OPENAI_API_KEY lookup: an agent that silently
  // picks up a key from the environment is an agent whose credential source is not in the record.
  return createOpenAI({ apiKey: cfg.openaiApiKey })(cfg.model);
}
