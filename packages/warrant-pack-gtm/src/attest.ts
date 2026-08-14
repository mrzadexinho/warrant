import type { Result } from '@idriszade/core';
import type { Principal, WarrantError } from '@idriszade/warrant-core';
import type { Ledger, LedgerEntry } from '@idriszade/warrant-ledger';

export async function markSent(opts: {
  runId: string;
  warrantId: string;
  operator: Principal;
  ledger: Ledger;
  now: () => Date;
}): Promise<Result<LedgerEntry, WarrantError>> {
  return opts.ledger.append({
    runId: opts.runId,
    at: opts.now().toISOString(),
    event: 'operator.attested',
    principal: opts.operator,
    payload: { warrantId: opts.warrantId, step: 'email_sent' },
  });
}
