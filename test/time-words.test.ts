// One clock across the app, one reset sentence, and one five-hour figure on the brief, Settings and the treasury (audit 2026-11-17).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { windowNowPct } from '../shared/market-rules.js';
import { clock, resetWords } from '../app/src/ui/time-words.js';
import * as treasuryWords from '../app/src/ui/treasury-words.js';
import { meterFigure } from '../app/src/ui/treasury-words.js';
import { usageLine } from '../app/src/ui/brief-words.js';
import { settingsWindow } from '../app/src/ui/settings-words.js';

const NOW = new Date(2026, 10, 17, 9, 30).getTime();
const sec = (ms: number): number => Math.floor(ms / 1000);

test('the clock is 24 hour, two digits each side, in local time', () => {
  assert.equal(clock(new Date(2026, 10, 17, 9, 5).getTime()), '09:05');
  assert.equal(clock(new Date(2026, 10, 17, 14, 12).getTime()), '14:12');
  assert.equal(clock(new Date(2026, 10, 17, 0, 0).toISOString()), '00:00');
  assert.equal(clock('not a time'), '');
});

test('a reset is said one way, from seconds or milliseconds alike', () => {
  const at = new Date(2026, 10, 17, 12, 32, 40).getTime();
  assert.equal(resetWords(sec(at), NOW), 'resets at 12:32');
  assert.equal(resetWords(at, NOW), 'resets at 12:32', 'milliseconds read the same as seconds');
  assert.equal(resetWords(sec(new Date(2026, 10, 18, 9, 5).getTime()), NOW), 'resets tomorrow at 09:05');
  assert.equal(resetWords(sec(new Date(2026, 10, 21, 14, 12).getTime()), NOW), 'resets Saturday at 14:12');
  assert.equal(resetWords(sec(new Date(2026, 10, 17, 8, 0).getTime()), NOW), 'reset at 08:00, after the last reading');
  assert.equal(resetWords(null, NOW), 'no reset time on record');
});

test('the treasury says resets with the same function', () => {
  assert.equal(treasuryWords.resetWords, resetWords);
});

test('the five-hour figure is windowNowPct on the brief, Settings and the treasury', () => {
  const w = { usedPct: 44, estimatedPct: 44.6, cityPct: 3, capPct: 50, resetsAt: sec(NOW + 3 * 3_600_000) };
  const now = windowNowPct(w);
  assert.equal(now, 45);
  assert.equal(meterFigure(w, NOW).text, '45%', 'the treasury headline');
  assert.match(meterFigure(w, NOW).note, /now/);
  assert.doesNotMatch(meterFigure(w, NOW).note, /last reading/, 'not the reading alone beside the figure now');
  assert.equal(settingsWindow(now, { usedPercentage: 44, resetsAt: w.resetsAt })?.pct, 45, 'Settings');
  const usage = { fiveHour: w, sevenDay: { ...w, usedPct: 21, estimatedPct: 21 }, todayCapPct: null } as unknown as Parameters<typeof usageLine>[0];
  assert.match(usageLine(usage, 50), /five-hour window stands at 45%/, 'the brief');
  assert.equal(meterFigure({ ...w, usedPct: null, estimatedPct: 0 }, NOW).text, 'unread');
  assert.equal(meterFigure({ ...w, resetsAt: sec(NOW - 60_000) }, NOW).text, 'unread', 'a window reset since the reading has nothing read');
});

test('no screen keeps a clock of its own: no 12 hour format, no locale time strings, no hand-padded hours', () => {
  const dir = new URL('../app/src/ui/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'time-words.ts')) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /hour:\s*'numeric'|hour12|toLocaleTimeString|getHours\(\)\)?\.padStart|\$\{d\.getHours\(\)\}:/, `${f} formats a time itself`);
    assert.doesNotMatch(src, /new Date\([^)]*\)\.toLocaleString\(/, `${f} prints a raw locale date and time`);
  }
});
