/**
 * The treasury screen's view logic (Task 39): the calibration line, a pause
 * said in plain words with the one action that clears it, when a window
 * resets, and the daily report's Markdown read into blocks the page builds
 * from text nodes, its tables included.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calibrationLine, pauseWords, reportBlocks, resetWords, spendFigure } from '../app/src/ui/treasury-words.js';

const H = 3_600_000;
/** A Tuesday afternoon, local time. */
const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();

test('the calibration line says measured and from how many pairs, or assumed', () => {
  assert.equal(calibrationLine({ tokensPerPct: 58_000, samples: 14, calibrated: true }), '1% of the window is about 58,000 weighted tokens, measured from 14 pairs.');
  assert.equal(calibrationLine({ tokensPerPct: 61_234.4, samples: 1, calibrated: true }), '1% of the window is about 61,234 weighted tokens, measured from 1 pair.');
  assert.equal(calibrationLine({ tokensPerPct: 60_000, samples: 0, calibrated: false }), '1% of the window is assumed to be about 60,000 weighted tokens until two readings measure it.');
});

test('a pause is said plainly, with the one action that clears it', () => {
  assert.equal(pauseWords(null, null, NOW), null, 'not paused');
  const stale = pauseWords({ reason: 'stale', detail: 'The last usage reading is more than five hours old.' }, { at: NOW - 6.2 * H, stale: true }, NOW)!;
  assert.equal(stale.action, 'resume');
  assert.equal(stale.title, 'Paused: your last usage reading is 6 hours old');
  assert.match(stale.text, /cannot see how much of your plan is left/);
  assert.match(stale.text, /Local models carry on/);
  const none = pauseWords({ reason: 'stale', detail: 'No usage reading yet.' }, null, NOW)!;
  assert.equal(none.title, 'Paused: no usage reading yet');
  assert.equal(none.action, 'resume');
  const stopped = pauseWords({ reason: 'stopped', detail: 'The stop switch is on.' }, { at: NOW, stale: false }, NOW)!;
  assert.equal(stopped.action, 'settings');
  assert.equal(stopped.title, 'Stopped: the stop switch is on');
  for (const reason of ['cap', 'night', 'hard'] as const) {
    const w = pauseWords({ reason, detail: 'The city has spent 50.0% of this window; the cap is 50%.' }, { at: NOW, stale: false }, NOW)!;
    assert.equal(w.action, null, `${reason} clears by itself`);
    assert.ok(w.text.includes('The city has spent 50.0% of this window; the cap is 50%.'), 'the engine’s own figures are kept');
  }
  for (const w of [stale, none, stopped]) assert.ok(!/[\u2014\u2013]|-{2}/.test(w.title + w.text), 'no dashes as punctuation');
});

test('a window says when it resets: today, tomorrow, on a weekday, or that it already has', () => {
  const sec = (ms: number) => Math.floor(ms / 1000);
  assert.equal(resetWords(sec(new Date(2026, 10, 10, 17, 20).getTime()), NOW), 'resets at 17:20');
  assert.equal(resetWords(sec(new Date(2026, 10, 11, 9, 5).getTime()), NOW), 'resets tomorrow at 09:05');
  assert.equal(resetWords(sec(new Date(2026, 10, 13, 9, 0).getTime()), NOW), 'resets Friday at 09:00');
  assert.equal(resetWords(sec(new Date(2026, 10, 10, 11, 40).getTime()), NOW), 'reset at 11:40, after the last reading');
  assert.equal(resetWords(null, NOW), 'no reset time on record');
});

test('a spend figure keeps two decimals, a thousands comma, and says nothing as a dot', () => {
  assert.equal(spendFigure(1234.5), '1,234.50');
  assert.equal(spendFigure(0.1 + 0.2), '0.30');
  assert.equal(spendFigure(0), '·');
});

test('the report reads into headings, paragraphs, notes and tables, as text', () => {
  const md = [
    '# Palimpsest, Monday 9 November 2026',
    '',
    'Today: 3 jobs posted, 2 awarded, 1 merged and 0 failed. The city spent 41.2 credits on model calls.',
    '',
    '## Waiting on you',
    '',
    '- A proposed job on lantern/assay-kit, "Add a test harness". Nothing bids on it until you accept it.',
    '- **Needs a reviewer.** acme/widgets, "Fix the header".',
    '  No firm could review it.',
    '- PR #12 on acme/widgets waits for your review (https://github.com/acme/widgets/pull/12).',
    '',
    '## Credits',
    '',
    '| Firm | Bids | Runs | Paid | Balance now |',
    '|:-|:-|:-|:-|:-|',
    '| Quickset | 3 | 18.5 | 0 | 278.5 |',
    '| Kiln Brothers | 0 | 4 | 17.5 | 313.5 |',
    '',
    '<script>alert(1)</script>',
  ].join('\n');
  const b = reportBlocks(md);
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'para', 'heading', 'list', 'heading', 'table', 'para']);
  assert.equal(b[0].kind === 'heading' && b[0].level, 1);
  const list = b[3];
  assert.ok(list.kind === 'list');
  assert.equal(list.items.length, 3, 'a note’s second line stays with its item');
  assert.deepEqual(list.items[1].map((s) => s.kind), ['strong', 'text', 'break', 'text']);
  assert.equal((list.items[2].find((s) => s.kind === 'link') as { href?: string } | undefined)?.href, 'https://github.com/acme/widgets/pull/12', 'a PR address is a link');
  const table = b[5];
  assert.ok(table.kind === 'table');
  assert.deepEqual(table.head, ['Firm', 'Bids', 'Runs', 'Paid', 'Balance now']);
  assert.deepEqual(table.rows[1], ['Kiln Brothers', '0', '4', '17.5', '313.5']);
  assert.deepEqual(table.numeric, [false, true, true, true, true], 'figures set right');
  const last = b[6];
  assert.ok(last.kind === 'para' && last.inline.every((s) => !s.text.includes('<')), 'tags are taken out, never markup');
});
