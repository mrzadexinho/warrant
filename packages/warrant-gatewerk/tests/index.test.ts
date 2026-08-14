// portfolio/packages/warrant-gatewerk/tests/index.test.ts
import { describe, it, expect } from 'vitest';
import {
  GatewerkGate,
  SimGate,
  verifyWebhookSignature,
  verifyGatewerkWebhook,
  rebindParamsForEdit,
  preflightGatewerkTemplate,
} from '../src/index.js';

// Gate, ReviewRequest, ReviewDecision, WebhookScheme, PreflightTemplate are plain interfaces and
// types: compile-time only, no runtime value. Assert the six contracted value exports (master
// §Gatewerk bridge: "Public API of this package is exactly: Gate, GatewerkGate, SimGate,
// ReviewRequest, ReviewDecision, verifyWebhookSignature, verifyGatewerkWebhook, WebhookScheme,
// rebindParamsForEdit (C8 adds the last two): plain interfaces, no Zod schemas here").
//
// Pass 2 adds preflightGatewerkTemplate and the PreflightTemplate type (plan contract P5). The
// quoted "exactly" sentence predates them; the amendment is recorded in the master plan's
// execution log rather than left as drift between this comment and src/index.ts.
describe('index re-exports', () => {
  it('exports all contracted value symbols', () => {
    expect(typeof GatewerkGate).toBe('function');
    expect(typeof SimGate).toBe('function');
    expect(typeof verifyWebhookSignature).toBe('function');
    expect(typeof verifyGatewerkWebhook).toBe('function');
    expect(typeof rebindParamsForEdit).toBe('function');
    expect(typeof preflightGatewerkTemplate).toBe('function');
  });
});
