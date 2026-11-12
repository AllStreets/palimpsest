/**
 * The one local-day function (Phase 3 Task 6): the day (YYYY-MM-DD, in the
 * Mac's time zone) that holds a moment. The report is filed under it, the
 * brief opens once in it and today's cap is set for it, so there is one
 * definition and every reader agrees on midnight.
 */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
