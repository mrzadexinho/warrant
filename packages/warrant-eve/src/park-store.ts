// ParkStore (C1): eve plumbing only. Holds NO authorization data. `callId` here is
// advisory: the ledger is authoritative, and resumeByPoll (a different task) cross-checks
// the park record's callId against the ledger's review.submitted requestId (step 6b of C11).
// This is why a corrupted or tampered park store can misroute an eve resume but cannot
// change what is authorized: authorization lives in the signed warrant on the ledger chain.
import { ok } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';

export interface ParkRecord {
  reviewId: string;
  runId: string;
  callId: string;          // ADVISORY: the ledger is authoritative; cross-checked in resumeByPoll.
  eveRequestId: string;    // eve's InputRequest.requestId: the only field with no ledger source.
  continuationToken: string;
  parkedAt: string;        // ISO
}

export interface ParkStore {
  put(rec: ParkRecord): Promise<Result<void, WarrantError>>;   // idempotent upsert on reviewId
  get(reviewId: string): Promise<Result<ParkRecord | null, WarrantError>>;  // absent -> ok(null)
}

export class MemoryParkStore implements ParkStore {
  private readonly records = new Map<string, ParkRecord>();

  async put(rec: ParkRecord): Promise<Result<void, WarrantError>> {
    this.records.set(rec.reviewId, structuredClone(rec));
    return ok(undefined);
  }

  async get(reviewId: string): Promise<Result<ParkRecord | null, WarrantError>> {
    const rec = this.records.get(reviewId);
    return ok(rec ? structuredClone(rec) : null);
  }
}
