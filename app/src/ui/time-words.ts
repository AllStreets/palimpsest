/**
 * The app's one clock (audit 2026-11-17): every screen writes a time of day
 * as the treasury, the job and run pages, the school and the inspections
 * always did, 24 hour with two digits each side ("09:05", "14:12"), in local
 * time; and a plan window's reset is worded here once, for Settings and the
 * treasury alike.
 */

const HOUR = 3_600_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const two = (n: number): string => String(n).padStart(2, '0');

/** "09:05", "14:12": a moment (epoch ms, an ISO string or a Date) as a local time of day; '' when it is not a time. */
export function clock(at: number | string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? '' : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A reset time in epoch ms, from Claude Code's seconds or from milliseconds. */
export function resetMs(resetsAt: number): number {
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/** When a window resets, from its `resetsAt` (seconds or ms): "resets at 17:20", "resets tomorrow at 09:05", "resets Friday at 09:00". */
export function resetWords(resetsAt: number | null, now: number): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return 'no reset time on record';
  const at = new Date(resetMs(resetsAt));
  if (at.getTime() <= now) return `reset at ${clock(at)}, after the last reading`;
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date(now))) / (24 * HOUR));
  if (days === 0) return `resets at ${clock(at)}`;
  if (days === 1) return `resets tomorrow at ${clock(at)}`;
  return `resets ${WEEKDAYS[at.getDay()]} at ${clock(at)}`;
}
