import { writeFile } from 'node:fs/promises';
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Ledger } from '@idriszade/warrant-ledger';
import type { WarrantError } from '@idriszade/warrant-core';

export async function exportLedgerJson(
  ledger: Ledger,
  outPath: string,
): Promise<Result<{ path: string }, WarrantError>> {
  try {
    const readResult = await ledger.readAll();
    if (readResult.error) {
      return err({ type: 'transient', code: 'export_failed', message: readResult.error.message });
    }
    await writeFile(outPath, JSON.stringify(readResult.data, null, 2));
    return ok({ path: outPath });
  } catch (e) {
    return err({
      type: 'transient',
      code: 'export_failed',
      message: e instanceof Error ? e.message : 'exportLedgerJson: unexpected error',
    });
  }
}
