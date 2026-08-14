// The regression test for a defect that made the entire PostgresLedger backend
// silently non-functional, and that no existing test could have caught.
//
// pg_advisory_xact_lock takes a SIGNED bigint. CHAIN_LOCK was built as an
// UNSIGNED BigInt from the first 16 hex chars of sha256('warrant-ledger'), which
// is 14425726651938269525: larger than int8's maximum. Postgres raised 22003 on
// every append, the catch mapped it to a generic db_error, and no entry was ever
// written. The advisory lock that the chain's append serialization depends on
// never engaged a single time.
//
// It hid because every Postgres conformance test is env-gated on
// WARRANT_TEST_DATABASE_URL and skips without a database, so the suite was green
// while the backend was dead. This test needs no database: it checks the
// constant itself, which is where the defect actually lived.
import { describe, it, expect } from 'vitest';
import { CHAIN_LOCK_KEY } from '../src/postgres.js';

const PG_INT8_MIN = -(2n ** 63n);
const PG_INT8_MAX = 2n ** 63n - 1n;

describe('PostgresLedger advisory lock key', () => {
  it('fits in a signed 64-bit integer, which is what pg_advisory_xact_lock accepts', () => {
    expect(CHAIN_LOCK_KEY).toBeGreaterThanOrEqual(PG_INT8_MIN);
    expect(CHAIN_LOCK_KEY).toBeLessThanOrEqual(PG_INT8_MAX);
  });

  it('is the signed reinterpretation of the sha256-derived constant, not a different value', () => {
    // Pins the derivation so a future "fix" cannot quietly change which lock is
    // taken. Two processes on different keys would both believe they hold the
    // chain lock, which is worse than the original bug.
    expect(CHAIN_LOCK_KEY).toBe(-4021017421771282091n);
  });

  it('is stable across calls', () => {
    expect(CHAIN_LOCK_KEY).toBe(CHAIN_LOCK_KEY);
  });
});
