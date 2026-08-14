import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import { generateKeyPair } from '@idriszade/warrant-core';
import { exportLedgerJson } from '../src/index.js';

const PRINCIPAL = { kind: 'agent' as const, id: 'agent-outbound' };

describe('exportLedgerJson', () => {
  it('exports ledger entries to JSON file and reads them back intact', async () => {
    const ledger = new MemoryLedger();

    await ledger.append({
      runId: 'run-1',
      at: '2026-07-18T10:00:00.000Z',
      event: 'warrant.requested',
      principal: PRINCIPAL,
      payload: { requestId: 'req-1', actionKind: 'send_email', target: 'user@example.com' },
    });
    await ledger.append({
      runId: 'run-1',
      at: '2026-07-18T10:00:01.000Z',
      event: 'policy.evaluated',
      principal: PRINCIPAL,
      payload: { requestId: 'req-1', ruleId: 'send_email_auto', path: 'auto' },
    });

    const allBefore = (await ledger.readAll()).data!;
    const outPath = join(tmpdir(), `wev-${Date.now()}.json`);

    const result = await exportLedgerJson(ledger, outPath);

    expect(result.error).toBeNull();
    expect(result.data!.path).toBe(outPath);

    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    expect(parsed).toEqual(allBefore);
  });

  it('returns err on unwritable path', async () => {
    const ledger = new MemoryLedger();
    await ledger.append({
      runId: 'run-1',
      at: '2026-07-18T10:00:00.000Z',
      event: 'warrant.requested',
      principal: PRINCIPAL,
      payload: {},
    });

    const result = await exportLedgerJson(ledger, '/no-such-dir/definitely-missing/out.json');

    expect(result.error).not.toBeNull();
    expect(result.error!.code).toBe('export_failed');
  });
});
