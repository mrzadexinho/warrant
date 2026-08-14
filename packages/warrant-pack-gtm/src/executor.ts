import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { err, ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { Warrant, WarrantError } from '@idriszade/warrant-core';
import { guardedExecute } from '@idriszade/warrant-guard';
import type { Ledger } from '@idriszade/warrant-ledger';

export const EmailParamsSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});
export type EmailParams = z.infer<typeof EmailParamsSchema>;

export interface ExecutorDeps {
  ledger: Ledger;
  publicKeyHex: string;
  outboxDir: string;
  now: () => Date;
}

/** Safe charset for warrant ids used as filesystem filenames. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * An actuator, and nothing more. **It holds no hashing logic and spends no nonce.**
 *
 * Everything between "is this warrant good for exactly these params" and "record what
 * happened" belongs to `guardedExecute` in `@idriszade/warrant-guard`. What stays here is the
 * two things that are genuinely this vendor's: the schema, and the effect closure.
 *
 * The filesystem checks stay here too, and they run **before** the guard on purpose: they are
 * a property of the destination rather than of the authority, and the guard spends the nonce
 * before running the effect. Validating the path afterwards would burn a warrant on a request
 * that was never going to be writable.
 */
export async function executeEmailQueue(
  warrant: Warrant,
  params: EmailParams,
  deps: ExecutorDeps,
): Promise<Result<{ outboxPath: string }, WarrantError>> {
  // Path traversal guard: warrant.id becomes a filename.
  if (!SAFE_ID_RE.test(warrant.id)) {
    return err<WarrantError>({
      type: 'validation',
      code: 'unsafe_warrant_id',
      message: `warrant.id contains characters not allowed in filenames: ${warrant.id}`,
    });
  }

  const outboxPath = join(deps.outboxDir, `${warrant.id}.json`);
  // Belt-and-suspenders: confirm the resolved path stays inside outboxDir.
  const resolvedTarget = resolve(outboxPath);
  const resolvedDir = resolve(deps.outboxDir);
  if (!resolvedTarget.startsWith(resolvedDir + '/') && resolvedTarget !== resolvedDir) {
    return err<WarrantError>({
      type: 'validation',
      code: 'unsafe_warrant_id',
      message: `Resolved outbox path escapes outboxDir: ${resolvedTarget}`,
    });
  }

  return guardedExecute(
    warrant,
    params,
    EmailParamsSchema,
    {
      publicKeyHex: deps.publicKeyHex,
      ledger: deps.ledger,
      now: deps.now,
      // This actuator queues rather than sends, and the ledger should say so.
      outcomeStatus: 'queued',
    },
    async (parsed) => {
      try {
        await mkdir(deps.outboxDir, { recursive: true });
        await writeFile(
          outboxPath,
          JSON.stringify(
            { warrantId: warrant.id, params: parsed, queuedAt: deps.now().toISOString() },
            null,
            2,
          ),
          'utf-8',
        );
      } catch (e) {
        return err<WarrantError>({
          type: 'transient',
          code: 'outbox_write_failed',
          message: `Failed to write outbox file: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return ok({ outboxPath });
    },
  );
}
