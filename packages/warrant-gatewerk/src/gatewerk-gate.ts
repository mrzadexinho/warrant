// portfolio/packages/warrant-gatewerk/src/gatewerk-gate.ts
import { ok, err } from '@idriszade/core';
import type { Result } from '@idriszade/core';
import type { WarrantError } from '@idriszade/warrant-core';
import type { ReviewRequest, ReviewDecision, Gate } from './types.js';
import { mapReviewDecision } from './decision.js';

export class GatewerkGate implements Gate {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #callbackUrl: string;
  readonly #templateSlug: string;
  readonly #fetch: typeof fetch;

  // NO process.env reads: pillar 7, a deliberate deviation from a4's env-in-module pattern
  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    callbackUrl: string;
    // Required, and deliberately without a default: a default here would be the last domain
    // word inside a package whose port carries content it never reads (contracts/gate.md §8).
    // Any default would name somebody else's domain instead; only the caller knows
    // which Gatewerk template renders its review.
    templateSlug: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#baseUrl = opts.baseUrl;
    this.#apiKey = opts.apiKey;
    this.#callbackUrl = opts.callbackUrl;
    this.#templateSlug = opts.templateSlug;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async submit(r: ReviewRequest): Promise<Result<{ reviewId: string }, WarrantError>> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/api/v1/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          template: this.#templateSlug,
          payload: r.content,
          callback_url: this.#callbackUrl,
          metadata: {
            paramsHash: r.metadata.paramsHash,
            stakesRuleId: r.metadata.stakesRuleId,
            runId: r.runId,
            requestId: r.requestId,
          },
          idempotency_key: r.requestId,
          // 'blocking' is load-bearing (spec 2.2, first of two independent
          // layers): 'monitoring' auto-confirms on silence with
          // decided_by:'system:monitoring_window'. timeout is intentionally
          // never sent: timeout.action:'auto_approve' produces a
          // machine-made approval. If a timeout is ever added it must be
          // 'expire'. Neither this layer nor decision.ts's guard may rely on
          // the other holding.
          oversight: 'blocking',
          priority: 'normal',
        }),
      });
      if (!res.ok) {
        return err({ type: 'transient', code: 'gatewerk_api_error', message: `${res.status} ${res.statusText}` });
      }
      const json = (await res.json()) as { id?: unknown };
      // A missing or blank id is a hard validation error, never a fabricated
      // identifier: this id later anchors a warrant, and a fallback value
      // would let an incident silently mint against the wrong review.
      if (typeof json.id !== 'string' || json.id.trim() === '') {
        return err({
          type: 'validation',
          code: 'gatewerk_missing_review_id',
          message: 'Gatewerk create response carried no usable id',
        });
      }
      return ok({ reviewId: json.id });
    } catch (e) {
      return err({ type: 'transient', code: 'gate_unreachable', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async fetchDecision(reviewId: string): Promise<Result<ReviewDecision | { pending: true }, WarrantError>> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/api/v1/reviews/${reviewId}`, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
      });
      if (!res.ok) {
        return err({ type: 'transient', code: 'gatewerk_api_error', message: `${res.status} ${res.statusText}` });
      }
      return mapReviewDecision(await res.json());
    } catch (e) {
      return err({ type: 'transient', code: 'gate_unreachable', message: e instanceof Error ? e.message : String(e) });
    }
  }
}
