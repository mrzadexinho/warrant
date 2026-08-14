# @idriszade/warrant-mcp

The MCP tool adapter. Governs an MCP tool call by calling the two existing seams,
`requestAuthority` then `guardedExecute`. Structurally typed against MCP tool shapes; no vendor
SDK dependency.

`governTool` wraps an MCP tool's handler so every call runs authorization then enforcement.
Everything between "was this permitted" and "did what executed stay inside what was permitted"
belongs to `warrant-authorize` and `warrant-guard`; this package holds only the translation
between an MCP tool call and their shapes. See
[`docs/contracts/adapter-authors-guide.md`](../../docs/contracts/adapter-authors-guide.md) for how
an adapter is expected to use both seams.

## Entry points

`governTool(tool, binding, schema, deps)`: takes a tool typed over authorized params and a binding
that describes how to build a request from a caller's raw arguments, and returns a tool typed over
those raw arguments.

```ts
import { governTool } from '@idriszade/warrant-mcp';

const governed = governTool(
  sendEmailTool,          // McpTool<EmailParams>, runs on authorized params
  {
    actionKind: 'send_email',
    principal: { type: 'agent', id: 'gtm-agent' },
    toTarget: (args) => args.to,
    toParams: (args) => ({ to: args.to, subject: args.subject, body: args.body }),
    toContext: (args) => ({ audience: 'external' }),
    toReviewTitle: (args) => `Send email to ${args.to}`,
    toReviewContent: (args) => ({ to: args.to, subject: args.subject, body: args.body }),
  },
  EmailParamsSchema,
  { policy, keys, ledger, now, newId, autoTtlMs, gate, publicKeyHex, outcomeStatus: 'sent' },
);
```

Three outcomes only: `deny` refuses without running the handler, `human` submits to the `Gate`
and stops (no warrant, no execution, no resume from this package), `auto` runs the handler under
the warrant `guardedExecute` verified.

## What it deliberately does not do

- **No third seam.** This package is a caller of `requestAuthority` and `guardedExecute`, not a
  reimplementation of either. Everything that decides permission or enforces it lives in those
  two packages.
- **No resume.** The `human` path ends at `pending review: <id>`. Resuming a parked call once a
  decision lands is out of scope for this adapter by design.
- **No governance fault worded as a denial.** An unreachable ledger or gate is reported as
  `governance unavailable: <reason>`, never as `refused by policy`, because the reader of an MCP
  tool result is usually a model deciding what to tell a person next, and the two are different
  facts.
- **No re-invocation of `toParams`.** Called exactly once per call, because the value hashed into
  the warrant and the value handed to the guard must be the same bytes.

## Tests

```bash
pnpm --filter "@idriszade/warrant-mcp" test
```
