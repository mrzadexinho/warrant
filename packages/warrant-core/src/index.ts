// src/index.ts: all public symbols; downstream packages import from @idriszade/warrant-core only
export type { WarrantError } from './errors.js';
export { canonicalJson } from './canonical.js';
export { sha256Hex, paramsHash } from './hash.js';
export type { KeyPair } from './keys.js';
export { generateKeyPair, signBytes, signHex, verifyBytes, verifyHex } from './keys.js';
export type { Principal, ActionRequest, Verdict, Warrant } from './types.js';
export { PrincipalSchema, ActionRequestSchema, VerdictSchema, WarrantSchema, MAX_TARGET_LENGTH } from './types.js';
export type { TrajectoryLeaf, TrajectoryAttestedPayload } from './types.js';
export { TrajectoryLeafSchema, TrajectoryAttestedPayloadSchema } from './types.js';
export type { IssueDeps } from './issue.js';
export { issueWarrant, verifyWarrant } from './issue.js';
