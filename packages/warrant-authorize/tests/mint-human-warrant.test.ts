/**
 * The human half of the seam: a decision plus provenance becomes a signed warrant, or a
 * typed refusal. Same discipline as the request path's tests: the action is a ticket, not
 * anything a shipping adapter would recognise, because this package's own tests must be
 * expressible for a runtime it has never heard of.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPair, paramsHash, verifyWarrant } from '@idriszade/warrant-core';
import type { WarrantError } from '@idriszade/warrant-core';
import { loadPolicy } from '@idriszade/warrant-policy';
import { mintHumanWarrant } from '../src/index.js';
import type { AuthorizedContent, HumanDecision, MintDeps } from '../src/index.js';

const POLICY_YAML = `
version: "1.0.0"
defaults:
  path: deny
stakes:
  - id: ticket_sensitive
    match:
      actionKind: open_ticket
      audience: sensitive
    path: human
  - id: ticket_auto
    match:
      actionKind: open_ticket
    path: auto
protectedAudiences:
  - "*.protected"
caps:
  perPrincipalDaily: {}
`.trim();

const KEYS = generateKeyPair('33'.repeat(32));
const AT = new Date('2026-07-18T10:00:00.000Z');

type TicketContent = { dest: string; note: string };

const isTicketContent = (v: unknown): v is TicketContent => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['dest'] === 'string' && o['dest'] !== '' && typeof o['note'] === 'string';
};

// Passes the narrowed object through WHOLE, exactly as a real narrowing does. A narrowing
// that rebuilt params from named fields would launder a merge back into a replace and make
// the replace-not-merge test below vacuous; that was measured, not guessed (a deliberate
// merge mutation survived the first version of this file).
const parseTicket = (v: unknown): AuthorizedContent<TicketContent> | null =>
  isTicketContent(v) ? { target: v.dest, params: v } : null;

function makeDeps(overrides: Partial<MintDeps> = {}): MintDeps {
  const loaded = loadPolicy(POLICY_YAML);
  if (loaded.error) throw new Error('policy load failed: ' + loaded.error.message);
  let tick = 0;
  return {
    policy: loaded.data,
    keys: KEYS,
    now: () => AT,
    newId: () => `id-${++tick}`,
    humanTtlMs: 60_000,
    ...overrides,
  };
}

const CONTENT: TicketContent = { dest: 'svc-a', note: 'restart the worker' };

function mint(overrides: {
  decision?: HumanDecision;
  content?: unknown;
  parseContent?: (v: unknown) => AuthorizedContent<TicketContent> | null;
  deps?: Partial<MintDeps>;
  context?: Record<string, unknown>;
  principal?: unknown;
} = {}) {
  return mintHumanWarrant<TicketContent>(
    {
      runId: 'run-1',
      requestId: 'req-1',
      reviewId: 'rev-1',
      principal: (overrides.principal ?? { kind: 'agent' as const, id: 'agent-1' }) as { kind: 'agent'; id: string },
      actionKind: 'open_ticket',
      originalContext: overrides.context ?? { audience: 'sensitive' },
      content: 'content' in overrides ? overrides.content : CONTENT,
      decision: overrides.decision ?? { decision: 'approved', decidedBy: 'reviewer:erin' },
      parseContent: overrides.parseContent ?? parseTicket,
    },
    makeDeps(overrides.deps),
  );
}

describe('mintHumanWarrant: the approved path', () => {
  it('mints a verifiable warrant whose path is human and whose reviewRef is the review', () => {
    const r = mint();
    expect(r.error).toBeNull();
    const { warrant, authorized } = r.data!;
    expect(authorized).toEqual(CONTENT);
    expect(warrant.action.target).toBe('svc-a');
    expect(warrant.verdictPath).toBe('human');
    expect(warrant.reviewRef).toBe('rev-1');
    expect(warrant.action.paramsHash).toBe(paramsHash(CONTENT));
    const v = verifyWarrant(warrant, KEYS.publicKeyHex, AT);
    expect(v.error).toBeNull();
  });

  it('the path stays human even when the re-evaluation of the final bytes says auto', () => {
    // With a non-sensitive context the re-evaluation lands on the auto rule. The warrant
    // still says human, because verdictPath records how authority arose: a person decided.
    const r = mint({ context: { audience: 'warm' } });
    expect(r.error).toBeNull();
    expect(r.data!.warrant.verdictPath).toBe('human');
  });

  it('a content the narrowing refuses is a typed refusal, and a scalar neither throws nor mints', () => {
    for (const content of [null, 42, 'dest: svc-a', { dest: '', note: 'x' }]) {
      const r = mint({ content });
      expect(r.error?.code).toBe('malformed_review_content');
      expect(r.error?.type).toBe('validation');
    }
  });
});

describe('mintHumanWarrant: the edited path', () => {
  it('the edit replaces the original whole; nothing from the original survives into the params', () => {
    // The original carries an extra field the edit omits. A merge would back-fill it,
    // producing params no human ever saw as a whole; replacement discards it.
    const r = mint({
      content: { dest: 'svc-a', note: 'v1', extra: 'left-behind' },
      decision: { decision: 'edited', decidedBy: 'reviewer:erin', editedContent: { dest: 'svc-b', note: 'v2' } },
    });
    expect(r.error).toBeNull();
    expect(r.data!.authorized).toEqual({ dest: 'svc-b', note: 'v2' });
  });

  it('an edited addressee moves the signed target with it', () => {
    const r = mint({
      decision: { decision: 'edited', decidedBy: 'reviewer:erin', editedContent: { dest: 'svc-b', note: 'v2' } },
    });
    expect(r.error).toBeNull();
    expect(r.data!.warrant.action.target).toBe('svc-b');
  });

  it('a scalar original still mints when the edit is well-formed: the edit alone is authorized', () => {
    const r = mint({
      content: 42,
      decision: { decision: 'edited', decidedBy: 'reviewer:erin', editedContent: { dest: 'svc-b', note: 'v2' } },
    });
    expect(r.error).toBeNull();
    expect(r.data!.authorized).toEqual({ dest: 'svc-b', note: 'v2' });
  });

  it('an edited decision with no editedContent is refused, never silently the original', () => {
    const r = mint({ decision: { decision: 'edited', decidedBy: 'reviewer:erin' } });
    expect(r.error?.code).toBe('edited_no_content');
  });
});

describe('mintHumanWarrant: fail-closed boundaries', () => {
  it('a rejected decision can never mint', () => {
    const r = mint({ decision: { decision: 'rejected', decidedBy: 'reviewer:erin' } });
    expect(r.error?.code).toBe('decision_not_approvable');
  });

  it('a decision naming no human is refused, whatever the caller checked upstream', () => {
    for (const decidedBy of ['', '   ']) {
      const r = mint({ decision: { decision: 'approved', decidedBy } });
      expect(r.error?.code).toBe('human_attestation_missing');
    }
  });

  it('re-evaluation runs on the FINAL content: an edit into a protected audience is denied', () => {
    const r = mint({
      decision: {
        decision: 'edited', decidedBy: 'reviewer:erin',
        editedContent: { dest: 'x.protected', note: 'v2' },
      },
    });
    expect(r.error?.code).toBe('policy_denied_on_final');
    expect(r.error?.type).toBe('validation');
  });

  it('a reconstructed request that fails the schema is refused at the boundary', () => {
    const r = mint({ principal: { kind: 'bogus', id: 'x' } });
    expect(r.error?.code).toBe('malformed_request');
  });

  it('a throwing narrowing becomes a typed permanent error, never a rejection', () => {
    const r = mint({ parseContent: () => { throw new Error('narrowing bug'); } });
    expect(r.error?.code).toBe('mint_internal_error');
    expect(r.error?.type).toBe('permanent');
  });

  it('an unusable signing key is issue_failed, and nothing is returned as a warrant', () => {
    const r = mint({ deps: { keys: { privateKeyHex: 'not-a-key', publicKeyHex: KEYS.publicKeyHex } } });
    expect(r.error?.code).toBe('issue_failed');
  });
});

// Keeps the refusal vocabulary enumerable for callers that record a denial reason.
it('every refusal code is one a caller can record as a denial reason', () => {
  const codes: Array<WarrantError['code']> = [];
  const cases: Array<() => ReturnType<typeof mint>> = [
    () => mint({ decision: { decision: 'rejected', decidedBy: 'reviewer:erin' } }),
    () => mint({ decision: { decision: 'approved', decidedBy: '' } }),
    () => mint({ decision: { decision: 'edited', decidedBy: 'reviewer:erin' } }),
    () => mint({ content: null }),
    () => mint({ principal: { kind: 'bogus', id: 'x' } }),
    () => mint({ decision: { decision: 'edited', decidedBy: 'reviewer:erin', editedContent: { dest: 'x.protected', note: 'v' } } }),
    () => mint({ deps: { keys: { privateKeyHex: 'not-a-key', publicKeyHex: KEYS.publicKeyHex } } }),
    () => mint({ parseContent: () => { throw new Error('bug'); } }),
  ];
  for (const c of cases) codes.push(c().error!.code);
  expect(codes).toEqual([
    'decision_not_approvable',
    'human_attestation_missing',
    'edited_no_content',
    'malformed_review_content',
    'malformed_request',
    'policy_denied_on_final',
    'issue_failed',
    'mint_internal_error',
  ]);
});
