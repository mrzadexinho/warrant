import { defineTool } from 'eve/tools';
import type { ToolDefinition, ToolContext, ToolModelOutput } from 'eve/tools';
import type { EveTool, EveToolCtx, WarrantEveDeps, WarrantToolBinding } from './deps.js';
import { buildApproval } from './approval.js';
import { buildExecute } from './execute.js';

/**
 * The tool a caller writes, typed over the params its handler receives, **not** over the tool
 * call's arguments. See `WarrantToolBinding`'s `P`: `withWarrant` is the translation between the
 * two, which is the whole job of an adapter.
 */
export interface PlainTool<P, O> {
  description: string;
  // Kept as unknown so callers can pass Zod schemas or JsonObject literals.
  inputSchema: unknown;
  outputSchema: unknown;
  execute: (params: P, ctx: EveToolCtx) => Promise<O> | O;
  toModelOutput?: (output: O) => ToolModelOutput | Promise<ToolModelOutput>;
}

export function withWarrant<I, P, O>(
  tool: PlainTool<P, O>,
  binding: WarrantToolBinding<I, P>,
  deps: WarrantEveDeps,
): EveTool<I, O> {
  const approval = buildApproval(binding, deps);
  const wrappedExecute = buildExecute(tool, binding, deps);

  // Use the last overload of defineTool: accepts a raw ToolDefinition<TInput, TOutput>.
  // We build the object first as ToolDefinition<I, O> then pass it through.
  const def: ToolDefinition<I, O> = {
    description: tool.description,
    inputSchema: tool.inputSchema as ToolDefinition<I, O>['inputSchema'],
    outputSchema: tool.outputSchema as ToolDefinition<I, O>['outputSchema'],
    approval: approval as ToolDefinition<I, O>['approval'],
    execute: (input: I, ctx: ToolContext) => wrappedExecute(input, ctx),
    ...(tool.toModelOutput !== undefined ? { toModelOutput: tool.toModelOutput } : {}),
  };

  // defineTool<TInput, TOutput>(def: ToolDefinition<TInput, TOutput>) last overload
  return defineTool<I, O>(def);
}
