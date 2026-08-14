/**
 * tests/binding-params-typing.test.ts: the guarantee that replaced `tool.execute(params as I, ctx)`.
 *
 * The cast was not a security hole: the effect only ever saw authorized bytes, which is precisely
 * why it was there. What it cost was the compile error. `buildExecute` derived the authorized
 * params from `binding.toParams(input)` (or read the reviewer's edited params back off the ledger)
 * and then handed them to a handler whose type said it receives the caller's input `I`. A binding
 * that renamed or dropped a field therefore left the handler reading `undefined`, silently.
 *
 * `WarrantToolBinding<I, P>` closes that: `P` is what `toParams` produces and the handler is typed
 * over `P`. The two `@ts-expect-error`s below are the assertion; each one FAILS `typecheck:tests`
 * if the error it expects ever stops being reported, which is the only way to pin a type property.
 * The runtime `expect`s exist so the file is also a test rather than only a compilation.
 */
import { describe, it, expect } from 'vitest';
import { withWarrant } from '../src/index.js';
import type { WarrantToolBinding } from '../src/index.js';
import { coldBinding, makeDeps, makePlainTool } from './fixtures.js';
import type { EmailInput } from './fixtures.js';

describe('a binding whose toParams does not produce what the handler reads', () => {
  it('renaming a field no longer compiles', () => {
    const renaming: WarrantToolBinding<EmailInput> = {
      ...coldBinding,
      // `body` renamed to `text`. `P` defaults to `I`, so this literal is no longer a valid
      // `toParams` return. Under the old `toParams: (i: I) => unknown` it compiled, and the
      // handler read `input.body === undefined` at runtime with nothing to warn anyone.
      // @ts-expect-error toParams must produce what the handler consumes
      toParams: (i) => ({ to: i.to, subject: i.subject, text: i.body }),
    };
    expect(typeof renaming.toParams).toBe('function');
  });

  it('a handler typed over the caller input no longer compiles against a projecting binding', () => {
    // A legitimate projection: the warrant is minted over the body alone. Naming `P` is now
    // mandatory to express it, and once named it must agree with the tool on both sides.
    const projecting: WarrantToolBinding<EmailInput, { body: string }> = {
      ...coldBinding,
      toParams: (i) => ({ body: i.body }),
    };
    const deps = makeDeps();
    // makePlainTool defaults to a handler over EmailInput, which is not what this binding
    // authorizes. That disagreement is the defect the cast used to absorb.
    // @ts-expect-error the tool's params and the binding's params must be the same type
    const wrong = withWarrant(makePlainTool(() => ({ messageId: 'x' })), projecting, deps);
    expect(wrong).toBeDefined();

    // Spelled correctly, it compiles: the fix constrains, it does not forbid.
    const right = withWarrant(makePlainTool<{ body: string }>(() => ({ messageId: 'x' })), projecting, deps);
    expect(typeof right.execute).toBe('function');
  });
});
