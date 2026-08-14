# @idriszade/warrant-policy

`evaluate(request, policy)`: pure, deterministic, deny-by-default policy evaluation.

Policy is a YAML document (protected audiences, daily caps, stakes rules) loaded into a typed,
hashed shape. `evaluate` is the only function that reads it against a request, and it never
touches the network, the clock, or history. Everything it needs to decide arrives inside
`request` and `policy`.

## Entry points

`loadPolicy(yamlText)`: parses and validates a policy document, and returns it paired with a
content hash.

```ts
import { loadPolicy } from '@idriszade/warrant-policy';

const loaded = loadPolicy(yamlText);
if (loaded.error) throw new Error(loaded.error.message);
const { doc, hash } = loaded.data;
```

`evaluate(request, policy)`: runs the request through the rules in a locked order, protected
audiences first, then daily caps, then the first matching stakes rule, then default deny. It
returns a `Verdict`, never throws.

```ts
import { evaluate } from '@idriszade/warrant-policy';

const verdict = evaluate(request, { doc, hash });
// verdict.path is 'auto' | 'human' | 'deny'
```

`PolicyDocSchema` is the Zod schema behind `loadPolicy`, exported for callers that want to
validate a document without loading it through the YAML path.

## What it deliberately does not do

- **No I/O, no clock, no history inside `evaluate`.** History reaches the engine only through
  `request.context`, never through a side channel, because that is what makes a verdict
  replayable from the ledger alone.
- **Malformed input denies rather than throws.** A non-string target, an oversized target, or a
  non-object context all return a `deny` verdict with `ruleId: 'malformed-request'`. `evaluate`
  never raises an exception for bad input.
- **No minting.** A `deny` verdict never carries a warrant. Only `warrant-authorize`, reading an
  `auto` verdict, calls `issueWarrant`.
- **No case-sensitivity trap.** Protected-audience matching lowercases both the pattern and the
  target before comparing, so a bypass by casing is not possible.

## Tests

```bash
pnpm --filter "@idriszade/warrant-policy" test
```

## An authoring footgun worth knowing

A stakes rule that requires a context key does not match when the key is absent. That is
correct on its own: absence is not equality. The footgun is what sits beneath it. If a
broader rule matches on `actionKind` alone and routes to `auto`, then an agent that simply
omits the narrowing key reaches that auto rule and skips the human route the stricter rule
intended. Two defenses: never author a catch-all auto rule beneath a key-gated human rule
(let omission fall to the default deny), and remember `defaults.path: deny` is the floor the
engine guarantees, not a substitute for rule ordering. The shipped GTM pack pins this
property in its own tests.
