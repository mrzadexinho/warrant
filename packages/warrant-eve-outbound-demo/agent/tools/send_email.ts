// Production deployment shape: deps come from the shared prod-deps singleton (master
// C13), so send_email, warrant-trigger, and gatewerk-review all observe the same
// ledger/parkStore within one running eve process. Tests drive logic in-process via
// src/build.ts's buildDeps() instead, which stays test-only.
//
// Pass 2: in ceremony mode the tool enqueues to the governed Postgres outbox and a separate drainer
// sends (design spec section 8). The demo path is unchanged. Both branches wrap the SAME binding
// through the SAME withWarrant, so the governed check surface never forks between them.
import { isCeremonyEnabled } from '../../src/config.js';
import { buildSendEmailTool } from '../../src/build.js';
import { buildGovernedSendEmailTool } from '../../src/governed-send-email.js';
import { getCeremonyRuntime, getDeps } from '../../src/prod-deps.js';

export default isCeremonyEnabled()
  ? buildGovernedSendEmailTool(getDeps(), getCeremonyRuntime().outbox)
  : buildSendEmailTool(getDeps());
