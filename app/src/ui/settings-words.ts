/**
 * Settings' words, kept apart from the page so they can be read and tested
 * alone: how a plan window reads on the page, and the one plain line under
 * each control a first-time reader would otherwise have to guess at.
 */
import type { UsageWindow } from '../../../shared/types.js';

/**
 * A window as Settings shows it: the figure as it stands now (the one the
 * brief and the treasury show, from GET /api/usage `now`), and how many
 * points of it the city spent since his last reading. With no figure for
 * now, the reading alone.
 */
export function settingsWindow(now: number | null | undefined, reading: UsageWindow | null | undefined): { pct: number; since: number } | null {
  if (!reading) return null;
  const read = Math.max(0, Math.min(100, Math.round(reading.usedPercentage)));
  if (typeof now !== 'number') return { pct: read, since: 0 };
  const pct = Math.max(0, Math.min(100, now));
  return { pct, since: Math.max(0, pct - read) };
}

/** The window as one line of the page: "45% used, 1 point of it by the city since your last reading; resets at 11:31." */
export function windowSentence(w: { pct: number; since: number }, reset: string): string {
  const since = w.since > 0 ? `, ${w.since} ${w.since === 1 ? 'point' : 'points'} of it by the city since your last reading` : '';
  return `${w.pct}% used${since}${reset ? `; ${reset}` : ''}.`;
}

/** Under the usage hook. */
export const HOOK_NOTE = 'It runs your own statusline as before and writes down only how much of your plan is used, so the city knows what it may spend.';

/** Under the API key's field. */
export const KEYCHAIN_NOTE = "The key goes into your Mac's keychain, never into a file; the city reads it only to call the API for a firm.";

/** Beside the API's daily limit. */
export const API_DAILY_NOTE = 'The most the firms may spend on the API in a day; past it, no firm calls the API until midnight.';

/** Under the API's switch and limit while no key is stored. */
export const API_NEEDS_KEY = 'These stay off until you store a key above.';

/** Whether the API's switch and daily limit are off: until a key is known to be stored (only whether one exists is ever read, never the key). */
export const apiControlsOff = (keySet: boolean | null): boolean => keySet !== true;

/** What the Quality row says under the picker: the note, the one button it offers (or none), and the line under the button (or none). */
export interface QualityNote {
  text: string;
  button: string | null;
  line: string | null;
}

/**
 * The city reads quality once when it opens, so the row compares the stored
 * choice with what the city draws at now. After the city stepped down by
 * itself the stored High still reads High, so the row says what the city
 * is drawing at and offers the way back; the engine is its own launchd
 * process, so a reopen costs the runs, bids and the school nothing.
 */
export function qualityNote(o: { stored: 'high' | 'medium'; drawn: 'high' | 'medium'; drop: { fps: number | null } | null }): QualityNote {
  if (o.stored === o.drawn) return { text: 'Read when the city opens.', button: null, line: null };
  if (o.drop && o.drawn === 'medium') {
    const at = o.drop.fps ? ` at ${Math.round(o.drop.fps)} fps` : '';
    return {
      text: `Drawing at medium now: the city stepped down by itself${at}.`,
      button: 'Reopen at high',
      line: 'Runs, bids and the school keep going while it reopens.',
    };
  }
  return { text: 'Takes effect when the city reopens.', button: 'Reopen now', line: null };
}
