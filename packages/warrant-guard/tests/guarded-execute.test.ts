/**
 * The guard. Every path to a side effect runs through this, so every fail-closed branch
 * below is a test rather than a comment.
 *
 * The schema here is deliberately NOT email. The guard's own tests must be expressible for
 * an actuator it has never heard of, or "vendor-blind" is a claim rather than a property.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Warrant, WarrantError } from '@idriszade/warrant-core';
import { generateKeyPair, issueWarrant } from '@idriszade/warrant-core';
import type { Ledger, LedgerAppendInput, LedgerEntry } from '@idriszade/warrant-ledger';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { guardedExecute } from '../src/index.js';
import type { GuardDeps } from '../src/index.js';

const { publicKeyHex, privateKeyHex } = generateKeyPair('a'.repeat(64));
const ISSUE_AT = new Date('2026-01-01T00:00:00Z');
const ACT_AT = new Date('2026-01-01T00:00:30Z');

/** A ticket, not an email. If the guard needs to know what this is, it is not a guard. */
const TicketSchema = z.object({
  ticketId: z.string().min(1),
  severity: z.number().int().min(1).max(5),
});
type Ticket = z.infer<typeof TicketSchema>;

const VALID: Ticket = { ticketId: 'INC-42', severity: 3 };

function makeWarrant(params: unknown, ttlMs = 60_000, nonce = 'nonce-1'): Warrant {
  const r = issueWarrant(
    {
      request: {
        id: 'req-1', runId: 'run-1',
        principal: { kind: 'agent' as const, id: 'agent-1' },
        action: { kind: 'open_ticket', target: 'svc-a', params },
        context: { entityId: 'e-1' },
      },
      verdict: {
        path: 'auto' as const, ruleId: 'auto-ticket',
        policyVersion: '0.1.0', policyHash: 'b'.repeat(64), reason: 'ok',
      },
      ttlMs,
    },
    { keys: { publicKeyHex, privateKeyHex }, now: () => ISSUE_AT, newId: () => nonce },
  );
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

const makeDeps = (ledger: Ledger, outcomeStatus = 'opened'): GuardDeps => ({
  publicKeyHex, ledger, now: () => ACT_AT, outcomeStatus,
});

const events = async (l: MemoryLedger): Promise<string[]> =>
  (await l.readAll()).data!.map((e) => e.event);

/** A ledger that fails the nth append of a given event. */
function failingLedger(event: string, error: WarrantError): Ledger {
  const inner = new MemoryLedger();
  return {
    append: async (input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>> =>
      input.event === event ? err(error) : inner.append(input),
    readRun: (runId: string) => inner.readRun(runId),
    readAll: () => inner.readAll(),
  };
}

describe('guardedExecute refuses before any effect', () => {
  it('refuses a warrant that does not verify, and touches nothing', async () => {
    const ledger = new MemoryLedger();
    const tampered = { ...makeWarrant(VALID), signature: 'f'.repeat(128) };
    const effect = vi.fn();

    const r = await guardedExecute(tampered, VALID, TicketSchema, makeDeps(ledger), effect);

    expect(r.error).not.toBeNull();
    expect(effect).not.toHaveBeenCalled();
    expect(await events(ledger)).toEqual([]);
  });

  it('refuses an expired warrant', async () => {
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID, 1); // expires 1ms after ISSUE_AT
    const effect = vi.fn();

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), effect);

    expect(r.error).not.toBeNull();
    expect(effect).not.toHaveBeenCalled();
    expect(await events(ledger)).toEqual([]);
  });

  it('refuses params that fail the schema, with a vendor-neutral code', async () => {
    const ledger = new MemoryLedger();
    const bad = { ticketId: '', severity: 99 };
    const warrant = makeWarrant(bad);
    const effect = vi.fn();

    const r = await guardedExecute(warrant, bad, TicketSchema, makeDeps(ledger), effect);

    expect(r.error?.code).toBe('invalid_params');
    expect(effect).not.toHaveBeenCalled();
    expect(await events(ledger)).toEqual([]);
  });

  it('refuses when the recomputed paramsHash does not match: GhostApproval', async () => {
    // The warrant was issued over VALID; the caller presents something else. What a human
    // approved and what would execute must be provably the same bytes.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);
    const swapped: Ticket = { ticketId: 'INC-999', severity: 1 };
    const effect = vi.fn();

    const r = await guardedExecute(warrant, swapped, TicketSchema, makeDeps(ledger), effect);

    expect(r.error?.code).toBe('params_mismatch');
    expect(effect).not.toHaveBeenCalled();
    expect(await events(ledger)).toEqual([]);
  });

  it('reports params_noncanonical distinctly from params_mismatch: they are different facts', async () => {
    // This path must never rewrite `params_noncanonical` into `params_mismatch`: a caller
    // needs to tell "your params contain a value canonicalJson rejects" apart from "somebody
    // changed the payload after it was authorized". Only the second is an alarm, and burying
    // the first inside it would dilute every real one.
    //
    // Reaching the branch needs a schema whose PARSED output is not JSON-representable,
    // contrived on purpose, because `guardedExecute` parses before it hashes, so the warrant
    // is issued over clean params and the fault appears only after the transform runs.
    const NonCanonicalSchema = TicketSchema.transform((t) => ({ ...t, seq: BigInt(t.severity) }));
    const ledger = new MemoryLedger();
    const effect = vi.fn();

    const r = await guardedExecute(makeWarrant(VALID), VALID, NonCanonicalSchema, makeDeps(ledger), effect);

    expect(r.error?.code).toBe('params_noncanonical');
    // Still fail-closed, which is what makes widening the returned set of codes safe: a caller
    // that recognises neither code still refuses, and nothing was spent or executed.
    expect(effect).not.toHaveBeenCalled();
    expect(await events(ledger)).toEqual([]);
  });

  it('hashes the PARSED form, so a schema that strips an unknown key still matches', async () => {
    // The bytes hashed must be the bytes acted on. Hashing the raw input would let an extra
    // key change the hash while the effect never sees it.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);
    const withExtra = { ...VALID, injected: 'ignored-by-schema' };

    const r = await guardedExecute(warrant, withExtra, TicketSchema, makeDeps(ledger), async () => ok('done'));

    expect(r.error).toBeNull();
    expect(r.data).toBe('done');
  });

  it('does not run the effect when action.executed cannot be appended', async () => {
    // The nonce is the single-spend record. If it cannot be written, acting would be an
    // unrecorded side effect.
    const ledger = failingLedger('action.executed', { type: 'transient', code: 'ledger_down', message: 'no' });
    const warrant = makeWarrant(VALID);
    const effect = vi.fn();

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), effect);

    expect(r.error?.code).toBe('ledger_down');
    expect(effect).not.toHaveBeenCalled();
  });
});

describe('guardedExecute spends the nonce before acting', () => {
  it('appends action.executed before the effect runs, and carries the nonce', async () => {
    // Order is the invariant: fail-closed means a burned nonce with no side effect, never a
    // side effect with no record. The nonce must be in the payload: Postgres enforces
    // single-spend on payload->>'nonce' with a unique partial index.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);
    let eventsWhenEffectRan: string[] = [];

    await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () => {
      eventsWhenEffectRan = await events(ledger);
      return ok('done');
    });

    expect(eventsWhenEffectRan).toEqual(['action.executed']);
    const entries = (await ledger.readAll()).data!;
    expect(entries[0]!.payload).toMatchObject({ warrantId: warrant.id, nonce: warrant.nonce });
  });

  it('refuses a second execution of the same warrant: the nonce is spent', async () => {
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);
    const deps = makeDeps(ledger);

    const first = await guardedExecute(warrant, VALID, TicketSchema, deps, async () => ok('done'));
    const second = await guardedExecute(warrant, VALID, TicketSchema, deps, async () => ok('done'));

    expect(first.error).toBeNull();
    expect(second.error).not.toBeNull();
  });

  it('appends under the warrant principal, not a separately supplied one', async () => {
    // Two sources for "who acted" is a hole. The warrant already binds the principal and
    // replay correlates on it, so the guard takes no principal of its own.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);

    await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () => ok('done'));

    const entries = (await ledger.readAll()).data!;
    expect(entries[0]!.principal).toEqual(warrant.principal);
    expect(entries[0]!.runId).toBe(warrant.runId);
  });
});

describe('guardedExecute records what happened', () => {
  it('records the vendor word for success in action.outcome', async () => {
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger, 'opened'), async () => ok('t-1'));

    expect(r.data).toBe('t-1');
    expect(await events(ledger)).toEqual(['action.executed', 'action.outcome']);
    const entries = (await ledger.readAll()).data!;
    expect(entries[1]!.payload).toMatchObject({ warrantId: warrant.id, status: 'opened' });
  });

  it('passes the parsed params to the effect', async () => {
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);
    const seen: Ticket[] = [];

    await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async (p) => {
      seen.push(p);
      return ok('done');
    });

    expect(seen).toEqual([VALID]);
  });

  it('records a FAILED effect in action.outcome: a burned nonce must not be a silent gap', async () => {
    // The nonce is spent before the effect, so a failure leaves authority consumed. A ledger
    // that says "executed" and never says what happened is the incomplete record the ledger
    // exists to prevent.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () =>
      err<WarrantError>({ type: 'transient', code: 'vendor_unreachable', message: 'timeout' }),
    );

    expect(r.error?.code).toBe('vendor_unreachable');
    expect(await events(ledger)).toEqual(['action.executed', 'action.outcome']);
    const entries = (await ledger.readAll()).data!;
    expect(entries[1]!.payload).toMatchObject({ warrantId: warrant.id, status: 'failed' });
  });

  it('returns the effect error even when recording that failure also fails', async () => {
    // Two failures: the caller must learn about the effect's, which is the one that says
    // whether the side effect happened.
    const ledger = failingLedger('action.outcome', { type: 'transient', code: 'ledger_down', message: 'no' });
    const warrant = makeWarrant(VALID);

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () =>
      err<WarrantError>({ type: 'transient', code: 'vendor_unreachable', message: 'timeout' }),
    );

    expect(r.error?.code).toBe('vendor_unreachable');
  });

  it('surfaces an outcome-append failure after a SUCCESSFUL effect', async () => {
    // The side effect happened and the ledger does not fully record it. That is not success.
    const ledger = failingLedger('action.outcome', { type: 'transient', code: 'ledger_down', message: 'no' });
    const warrant = makeWarrant(VALID);

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () => ok('t-1'));

    expect(r.error?.code).toBe('outcome_append_failed');
  });

  it('does not let an effect that throws escape as a rejection', async () => {
    // Actuators call vendor SDKs. An unguarded throw past this boundary would skip the
    // outcome record entirely.
    const ledger = new MemoryLedger();
    const warrant = makeWarrant(VALID);

    const r = await guardedExecute(warrant, VALID, TicketSchema, makeDeps(ledger), async () => {
      throw new Error('sdk exploded');
    });

    expect(r.error?.code).toBe('effect_threw');
    expect(r.error?.message).toContain('sdk exploded');
    expect(await events(ledger)).toEqual(['action.executed', 'action.outcome']);
  });
});
