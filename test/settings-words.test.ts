import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_DAILY_NOTE, HOOK_NOTE, KEYCHAIN_NOTE, settingsWindow, windowSentence } from '../app/src/ui/settings-words.js';

test('Settings shows a window as it stands now, the figure the brief shows, not the reading alone', () => {
  // The audit's moment: the reading said 44%, the city has spent since, the brief says 45%.
  assert.deepEqual(settingsWindow(45, { usedPercentage: 44, resetsAt: 0 }), { pct: 45, since: 1 });
  assert.deepEqual(settingsWindow(21, { usedPercentage: 21.2, resetsAt: 0 }), { pct: 21, since: 0 });
  // The treasury could not be read: the reading still holds.
  assert.deepEqual(settingsWindow(null, { usedPercentage: 43.6, resetsAt: 0 }), { pct: 44, since: 0 });
  assert.deepEqual(settingsWindow(undefined, { usedPercentage: 12, resetsAt: 0 }), { pct: 12, since: 0 });
  assert.equal(settingsWindow(null, null), null);
});

test('a window reads as a sentence on the page, not a tile', () => {
  assert.equal(windowSentence({ pct: 45, since: 1 }, 'resets at 11:31'), '45% used, 1 point of it by the city since your last reading; resets at 11:31.');
  assert.equal(windowSentence({ pct: 21, since: 0 }, 'resets Thursday at 13:11'), '21% used; resets Thursday at 13:11.');
  assert.equal(windowSentence({ pct: 50, since: 3 }, ''), '50% used, 3 points of it by the city since your last reading.');
});

test('the hook, the keychain and the daily limit each say in one plain line what they do', () => {
  for (const line of [HOOK_NOTE, KEYCHAIN_NOTE, API_DAILY_NOTE]) {
    assert.ok(line.length > 40 && line.length < 200, line);
    assert.ok(!/\u2014|--/.test(line), 'no em dash or double hyphen');
    assert.match(line, /\.$/);
  }
  assert.match(HOOK_NOTE, /statusline/);
  assert.match(KEYCHAIN_NOTE, /keychain/);
  assert.match(API_DAILY_NOTE, /midnight/);
});
