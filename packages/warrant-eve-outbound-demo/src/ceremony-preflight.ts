// ceremony-preflight.ts: checks that must PASS before a live run, run against the real deployment.
//
// The template check (in @idriszade/warrant-gatewerk) is the only PREVENTIVE layer against a
// self-deciding template: other checks run after the review already exists, so by then
// an auto_approve template has already stamped decided/approved/system-auto-approve on it.
//
// The ledger check lives in @idriszade/warrant-ledger and is re-exported here so the
// ceremony's own call sites and tests keep one import path. It has two consumers (this
// ceremony and `provisionLedger`) and it belongs beside `applyAppendOnlyGuards`, which installs the
// property it proves: a change to the trigger names must land in front of one reader, not two. See
// that file's header for the full reasoning.
export { assertLedgerAppendOnly } from '@idriszade/warrant-ledger';
export type { AppendOnlyProof } from '@idriszade/warrant-ledger';
