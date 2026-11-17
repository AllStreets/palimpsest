/**
 * The API's event stream stops reading when its call is cut off
 * (engine/market/anthropic-api.ts readStream): a body the fetch's own abort
 * never reaches still ends at once, with the usage seen so far, rather than
 * waiting out undici's 300 s body timeout ("anthropic complete stops at
 * maxMs" stalled that long twice in full runs).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readStream } from '../engine/market/anthropic-api.js';

test('a stream that never ends stops reading when its signal fires, with what it spent so far', async () => {
  const start = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 4000, output_tokens: 0 } } })}\n\n`;
  // One event, then nothing ever again, and nothing that would see the fetch's abort: only the reader's cancel ends it.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(start));
    },
    pull: () => new Promise<void>(() => {}),
  });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  const err = await readStream(new Response(body), () => {}, ctl.signal).then(
    () => null,
    (e: unknown) => e as Error & { partialUsage?: { input: number } },
  );
  assert.ok(err, 'the read is cut off');
  assert.match(err.message, /cut off/);
  assert.ok(Date.now() - t0 < 2000, `it ends at once (${Date.now() - t0} ms)`);
  assert.equal(err.partialUsage?.input, 4000, 'the usage seen so far stays with it, to be charged');
});

test('a stream that ends with message_stop is read whole although its signal fires after', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const ctl = new AbortController();
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const out = await readStream(new Response(text), () => {}, ctl.signal);
  ctl.abort();
  assert.equal(out.blocks[0]?.text, 'done');
  assert.equal(out.usage.output, 2);
});
