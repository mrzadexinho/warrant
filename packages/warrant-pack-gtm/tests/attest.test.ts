import { describe, it, expect } from 'vitest';
import { err, ok } from '@idriszade/core';
import type { Ledger } from '@idriszade/warrant-ledger';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { markSent } from '../src/attest.js';

describe('markSent', () => {
  it('appends operator.attested with runId (not warrantId) as the entry runId', async () => {
    const ledger = new MemoryLedger();
    const operator = { kind: 'human' as const, id: 'ops-alice' };
    const result = await markSent({
      runId: 'run-42',
      warrantId: 'w-123',
      operator,
      ledger,
      now: () => new Date('2026-07-16T10:00:00Z'),
    });
    expect(result.error).toBeNull();
    expect(result.data?.event).toBe('operator.attested');
    expect(result.data?.runId).toBe('run-42');
    expect(result.data?.principal).toEqual(operator);
    const payload = result.data?.payload as { warrantId: string; step: string };
    expect(payload.warrantId).toBe('w-123');
    expect(payload.step).toBe('email_sent');
  });

  it('propagates ledger error without swallowing', async () => {
    const failLedger: Ledger = {
      append: async () => err({ type: 'transient' as const, code: 'ledger_down', message: 'down' }),
      readRun: async () => ok([]),
      readAll: async () => ok([]),
    };
    const result = await markSent({
      runId: 'run-99',
      warrantId: 'w-xyz',
      operator: { kind: 'human' as const, id: 'ops-bob' },
      ledger: failLedger,
      now: () => new Date('2026-07-16T10:00:00Z'),
    });
    expect(result.error?.code).toBe('ledger_down');
    expect(result.data).toBeNull();
  });
});
