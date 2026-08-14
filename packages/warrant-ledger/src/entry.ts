import { createHash } from 'node:crypto';
import { canonicalJson } from '@idriszade/warrant-core';
import type { Principal } from '@idriszade/warrant-core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

// 'trajectory.attested' is the one OPTIONAL event and the only one appended by a producer
// upstream of Warrant (Millwerk's Composer). It required no migration: warrant_ledger.event
// is plain TEXT with no CHECK constraint. Its payload schema lives in warrant-core, not here:
// the ledger's payloads are deliberately `unknown` and it owns no contract shapes.
export type LedgerEventType =
  | 'warrant.requested' | 'policy.evaluated' | 'review.submitted' | 'review.decided'
  | 'warrant.issued' | 'warrant.denied' | 'warrant.voided'
  | 'action.executed' | 'action.outcome' | 'operator.attested'
  | 'trajectory.attested';

export interface LedgerAppendInput {
  runId: string; at: string; event: LedgerEventType; principal: Principal; payload: unknown;
}
export interface LedgerEntry extends LedgerAppendInput { seq: number; prevHash: string; hash: string; }

export const GENESIS_PREV_HASH = '0'.repeat(64);

export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  const body = canonicalJson({ runId: e.runId, at: e.at, event: e.event, principal: e.principal, payload: e.payload });
  return createHash('sha256').update(`${e.seq}\n${e.prevHash}\n${body}`, 'utf8').digest('hex');
}

function stringPayloadField(payload: unknown, key: string): string | undefined {
  if (typeof payload === 'object' && payload !== null && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

// Backs the (event, reviewId) claim-uniqueness constraint (master C5): review.submitted and
// review.decided carry reviewId. Returns undefined when absent, non-string, or payload is not
// a plain object (NOT the string 'undefined': callers treat undefined as unconstrained).
export function reviewIdOf(payload: unknown): string | undefined {
  return stringPayloadField(payload, 'reviewId');
}

// Backs the (event, reviewRef) claim-uniqueness constraint (master C5): warrant.issued and the
// human-path warrant.denied carry reviewRef, never reviewId. Kept as a distinct field name
// (never renamed to reviewId): warrant-agent-outbound and a golden-parity test depend on it.
export function reviewRefOf(payload: unknown): string | undefined {
  return stringPayloadField(payload, 'reviewRef');
}

export interface Ledger {
  append(input: LedgerAppendInput): Promise<Result<LedgerEntry, WarrantError>>;
  readRun(runId: string): Promise<Result<LedgerEntry[], WarrantError>>;
  readAll(): Promise<Result<LedgerEntry[], WarrantError>>;
}
