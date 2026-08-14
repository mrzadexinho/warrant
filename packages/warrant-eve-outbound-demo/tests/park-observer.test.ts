// Unit tests for src/park-observer.ts. eve is a types-only dependency here: every event
// is a hand-built object matching eve's stream event shapes, and no eve runtime is
// started.
import { describe, it, expect } from 'vitest';
import { err } from '@idriszade/core';
import { MemoryLedger } from '@idriszade/warrant-ledger';
import type { Ledger } from '@idriszade/warrant-ledger';
import { MemoryParkStore } from '@idriszade/warrant-eve';
import { handleParkObserverEvent, consumeParkObserverStream } from '../src/park-observer.js';
import type { ParkObserverEvent } from '../src/park-observer.js';

const NOW = () => new Date('2026-07-26T12:00:00.000Z');

async function seedReview(ledger: MemoryLedger, requestId: string, reviewId: string): Promise<void> {
  await ledger.append({
    runId: 'run-1', at: NOW().toISOString(), event: 'review.submitted',
    principal: { kind: 'agent', id: 'a' }, payload: { requestId, reviewId, content: {} },
  });
}

function brokenLedger(): Ledger {
  return {
    append: async () => { throw new Error('not used in this test'); },
    readRun: async () => err({ type: 'transient', code: 'ledger_read_error', message: 'read failed' }),
    readAll: async () => err({ type: 'transient', code: 'ledger_read_error', message: 'read failed' }),
  };
}

describe('handleParkObserverEvent', () => {
  it('parks when requestId matches a ledger review.submitted', async () => {
    const ledger = new MemoryLedger();
    await seedReview(ledger, 'call-1', 'review-1');
    const parkStore = new MemoryParkStore();
    const event: ParkObserverEvent = { type: 'input.requested',
      data: { requests: [{ requestId: 'eve-req-1', action: { callId: 'call-1' } }] } };
    const result = await handleParkObserverEvent(event,
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect(result.data).toBe('continue');
    const rec = (await parkStore.get('review-1')).data;
    expect(rec).toMatchObject({ callId: 'call-1', eveRequestId: 'eve-req-1' });
    // callId (ledger's requestId, advisory) and eveRequestId (eve's InputRequest.requestId)
    // are two genuinely distinct identifiers here, not coincidentally equal test fixtures.
    expect(rec!.callId).not.toBe(rec!.eveRequestId);
  });

  it('no matching review.submitted does NOT park and does NOT throw', async () => {
    const ledger = new MemoryLedger();
    const parkStore = new MemoryParkStore();
    const event: ParkObserverEvent = { type: 'input.requested',
      data: { requests: [{ requestId: 'eve-req-2', action: { callId: 'call-unknown' } }] } };
    const result = await handleParkObserverEvent(event,
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect(result).toMatchObject({ data: 'continue', error: null });
    expect((await parkStore.get('review-1')).data).toBeNull();
  });

  it.each(['session.waiting', 'session.completed', 'session.failed'])('stops on %s', async (type) => {
    const ledger = new MemoryLedger();
    const parkStore = new MemoryParkStore();
    const result = await handleParkObserverEvent({ type },
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect(result.data).toBe('stop');
  });

  it('a ledger read failure writes no park record and does not throw', async () => {
    const ledger = brokenLedger();
    const parkStore = new MemoryParkStore();
    const event: ParkObserverEvent = { type: 'input.requested',
      data: { requests: [{ requestId: 'eve-req-9', action: { callId: 'call-9' } }] } };
    const result = await handleParkObserverEvent(event,
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe('ledger_read_error');
    expect((await parkStore.get('review-9')).data).toBeNull();
  });
});

describe('consumeParkObserverStream', () => {
  it('drains a stream, parking matches until a terminal event', async () => {
    const ledger = new MemoryLedger();
    await seedReview(ledger, 'call-1', 'review-1');
    const parkStore = new MemoryParkStore();
    const events: ParkObserverEvent[] = [
      { type: 'input.requested', data: { requests: [{ requestId: 'eve-req-1', action: { callId: 'call-1' } }] } },
      { type: 'session.waiting' },
    ];
    const stream = new ReadableStream<ParkObserverEvent>({
      start(c) { for (const e of events) c.enqueue(e); c.close(); },
    });
    await consumeParkObserverStream(stream, { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect((await parkStore.get('review-1')).data).not.toBeNull();
  });

  it('parks each of multiple input.requested events into its own record', async () => {
    const ledger = new MemoryLedger();
    await seedReview(ledger, 'call-1', 'review-1');
    await seedReview(ledger, 'call-2', 'review-2');
    const parkStore = new MemoryParkStore();
    const events: ParkObserverEvent[] = [
      { type: 'input.requested', data: { requests: [{ requestId: 'eve-req-1', action: { callId: 'call-1' } }] } },
      { type: 'input.requested', data: { requests: [{ requestId: 'eve-req-2', action: { callId: 'call-2' } }] } },
      { type: 'session.waiting' },
    ];
    const stream = new ReadableStream<ParkObserverEvent>({
      start(c) { for (const e of events) c.enqueue(e); c.close(); },
    });
    await consumeParkObserverStream(stream, { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW });
    expect((await parkStore.get('review-1')).data).toMatchObject({ callId: 'call-1', eveRequestId: 'eve-req-1' });
    expect((await parkStore.get('review-2')).data).toMatchObject({ callId: 'call-2', eveRequestId: 'eve-req-2' });
  });

  it('a stream that errors mid-consumption resolves cleanly, no unhandled rejection', async () => {
    const ledger = new MemoryLedger();
    const parkStore = new MemoryParkStore();
    const stream = new ReadableStream<ParkObserverEvent>({
      start(controller) { controller.error(new Error('stream boom')); },
    });
    await expect(consumeParkObserverStream(stream,
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW }),
    ).resolves.toBeUndefined();
  });

  it('a ledger read failure mid-stream stops the drain without throwing', async () => {
    const ledger = brokenLedger();
    const parkStore = new MemoryParkStore();
    const stream = new ReadableStream<ParkObserverEvent>({
      start(c) {
        c.enqueue({ type: 'input.requested', data: { requests: [{ requestId: 'eve-req-1', action: { callId: 'call-1' } }] } });
        c.close();
      },
    });
    await expect(consumeParkObserverStream(stream,
      { ledger, parkStore, runId: 'run-1', continuationToken: 'tok-1', now: NOW }),
    ).resolves.toBeUndefined();
    expect((await parkStore.get('review-1')).data).toBeNull();
  });
});
