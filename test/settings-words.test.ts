import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { API_DAILY_NOTE, API_NEEDS_KEY, apiControlsOff, HOOK_NOTE, KEYCHAIN_NOTE, qualityNote, settingsWindow, windowSentence } from '../app/src/ui/settings-words.js';

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

test('the Quality note: nothing to reopen, a choice waiting for a reopen, and the city stepped down by itself', () => {
  const none = { text: 'Read when the city opens.', button: null, line: null };
  // No drop, the stored choice is what the city draws at: read when the city opens, no button.
  assert.deepEqual(qualityNote({ stored: 'high', drawn: 'high', drop: null }), none);
  // No drop, a different choice stored: it waits for a reopen.
  assert.deepEqual(qualityNote({ stored: 'medium', drawn: 'high', drop: null }), { text: 'Takes effect when the city reopens.', button: 'Reopen now', line: null });
  // The city stepped down by itself and the stored High still reads High: say so, and offer the way back.
  assert.deepEqual(qualityNote({ stored: 'high', drawn: 'medium', drop: { fps: 43 } }), {
    text: 'Drawing at medium now: the city stepped down by itself at 43 fps.',
    button: 'Reopen at high',
    line: 'Runs, bids and the school keep going while it reopens.',
  });
  // No measured rate (a drop asked for before any frame): the sentence leaves the figure out.
  assert.equal(qualityNote({ stored: 'high', drawn: 'medium', drop: { fps: null } }).text, 'Drawing at medium now: the city stepped down by itself.');
  // After a drop, Medium stored is what the city already draws: no reopen.
  assert.deepEqual(qualityNote({ stored: 'medium', drawn: 'medium', drop: { fps: 43 } }), none);
  // Opened at medium by choice (no drop), then High stored: an ordinary reopen.
  assert.deepEqual(qualityNote({ stored: 'high', drawn: 'medium', drop: null }), { text: 'Takes effect when the city reopens.', button: 'Reopen now', line: null });
});

test('the API switch and daily limit stay off until a key is stored, and say so in one quiet line', () => {
  assert.equal(apiControlsOff(false), true);
  assert.equal(apiControlsOff(null), true, 'a keychain that could not be asked is not a key');
  assert.equal(apiControlsOff(true), false);
  assert.equal(API_NEEDS_KEY, 'These stay off until you store a key above.');
  assert.ok(!/\u2014|--/.test(API_NEEDS_KEY));
});

test('with no key stored the toggle and the dollar field look disabled, and the reason sits right beside them', () => {
  const root = new URL('../app/src/ui/', import.meta.url);
  const ts = readFileSync(new URL('settings.ts', root), 'utf8');
  const css = readFileSync(new URL('screens.css', root), 'utf8');
  // The reason follows the dollar field directly, before the limit's own note.
  assert.match(ts, /apiControls\.append\(enableWrap, dailyLine, needsKey, dailyNote\)/);
  // The field is read only as well as disabled while no key is stored.
  assert.match(ts, /daily\.readOnly = off/);
  // Greyed out, with a not-allowed cursor over the switch, the field and its label.
  // Every declaration of the rules whose selector list names `sel`.
  const rule = (sel: string): string =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => m[1].split(',').some((x) => x.trim() === sel))
      .map((m) => m[2])
      .join('\n');
  for (const sel of ['.apikey-controls.needs-key .apikey-enable-wrap', '.apikey-controls.needs-key .apikey-daily-line']) {
    assert.match(rule(sel), /cursor: not-allowed/, sel);
    assert.match(rule(sel), /grayscale/, sel);
    assert.match(rule(sel), /opacity/, sel);
  }
  assert.match(rule('.apikey-controls.needs-key .apikey-daily'), /cursor: not-allowed/);
  assert.match(rule('.apikey-controls.needs-key .apikey-daily'), /dashed/);
});
