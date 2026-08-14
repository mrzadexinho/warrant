import type { Principal } from '@idriszade/warrant-core';
import type { AuthorizeDeps } from '@idriszade/warrant-authorize';
import type { Gate, ReviewContent } from '@idriszade/warrant-gatewerk';

/**
 * MCP tools are typed structurally here, not by depending on any MCP server SDK package.
 * Warrant's packages name no vendor: the same rule that produced `ReviewContent` in
 * `warrant-gatewerk`. These shapes match what such an SDK hands a tool handler and returns from
 * it, without this package ever depending on, or importing a type from, the SDK itself.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * A tool, named by what its handler receives.
 *
 * **The type parameter is load-bearing and the two uses of it in `governTool` are different
 * types on purpose.** The tool handed *in* is an `McpTool<T>`: it runs on the params the
 * warrant authorized. The tool handed *back* is an `McpTool<I>`: it takes the client's raw
 * arguments. `governTool` is the translation between them, which is the entire job of an
 * adapter.
 *
 * Getting this wrong is not a style matter. What executes must be what was authorized: on the
 * human path a reviewer may edit the params, and a handler run against the original arguments
 * would execute something nobody approved. That is the GhostApproval property, and it is why
 * the inner handler cannot be typed over the client's arguments.
 */
export interface McpTool<I> {
  name: string;
  handler: (args: I) => Promise<McpToolResult>;
}

/**
 * How a caller's tool call becomes the four things the two seams need: an `ActionRequest`
 * (`actionKind`, `principal`, `toTarget`, `toParams`, `toContext`), and, only if policy routes
 * to a human, a review (`toReviewTitle`, `toReviewContent`).
 *
 * `toReviewContent` returns `ReviewContent`, the opaque `Record<string, unknown>` from
 * `@idriszade/warrant-gatewerk`. This package never reads a field of it; a binding names
 * whatever shape its own Gatewerk template renders. For an MCP tool call the natural shape is
 * `{ toolName, arguments }`, not an email, which is the whole point of this adapter existing
 * alongside `warrant-eve`'s.
 */
export interface McpToolBinding<I> {
  actionKind: string;
  principal: Principal;
  toTarget: (args: I) => string;
  toParams: (args: I) => unknown;
  toContext: (args: I) => Record<string, unknown>;
  toReviewTitle: (args: I) => string;
  toReviewContent: (args: I) => ReviewContent;
}

/**
 * Everything `governTool` needs beyond the tool and the binding: `AuthorizeDeps` for
 * `requestAuthority`, plus what `guardedExecute` and the `Gate` submission need on top.
 */
export interface GovernToolDeps extends AuthorizeDeps {
  gate: Gate;
  publicKeyHex: string;
  outcomeStatus: string;
  /**
   * The run a governed call belongs to. **Optional, and the default is deliberately the weakest
   * useful answer:** absent one, every tool call becomes its own single-action run, because an
   * MCP tool call carries no session identifier this package is entitled to invent.
   *
   * A caller that *has* a session should supply it, e.g. `runId: () => session.id`, and get one run
   * spanning the conversation, which is what makes a single certificate cover a sequence of tool
   * calls rather than fragmenting into one per call. The knowledge lives with the caller, so the
   * choice does too.
   */
  runId?: () => string;
}
