import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { api } from '../app/src/api.js';
import type { EngineEvent } from '../app/src/api.js';

/** Stands in for the browser's EventSource: the test opens, drops and reopens it by hand. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (msg: { data: string }) => void>();

  constructor(public url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, fn: (msg: { data: string }) => void): void {
    this.listeners.set(type, fn);
  }

  close(): void {
    this.closed = true;
  }

  send(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

const original = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = original;
});

test('after the event stream drops and comes back, a reconnected event says the city and repos may be stale', () => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  const seen: EngineEvent[] = [];
  const close = api.events((e) => seen.push(e));
  const source = FakeEventSource.last!;

  source.onopen?.();
  assert.deepEqual(seen, [], 'the first open is not a reconnect');

  source.send('repo.connected', { repo: { fullName: 'acme/widgets' } });
  assert.equal(seen.length, 1);

  source.onerror?.();
  source.onerror?.();
  source.onopen?.();
  assert.deepEqual(seen.slice(1), [{ type: 'engine.reconnected', data: null }], 'one reconnect after the stream came back');

  source.onopen?.();
  assert.equal(seen.length, 2, 'an open with no error before it is not another reconnect');

  close();
  assert.equal(source.closed, true);
});
