/**
 * What the Repos screen keeps between events, as plain functions the tests
 * reach without a page.
 */

/** Repo events after which a reason the engine gave for refusing push mode no longer describes the repo. */
const PUSH_WHY_STALE = new Set(['repo.connected', 'repo.disconnected', 'repo.analyzed', 'repo.patched']);

/**
 * Drops the push-mode reasons an event makes stale: its repo's when the repo
 * reconnects, re-analyses or changes, and every one when the stream comes
 * back after missing events.
 */
export function forgetPushWhy(why: Map<string, string>, e: { type: string; data: unknown }): void {
  if (e.type === 'engine.reconnected') {
    why.clear();
    return;
  }
  if (!PUSH_WHY_STALE.has(e.type)) return;
  const fullName = (e.data as { repo?: { fullName?: unknown } } | null)?.repo?.fullName;
  if (typeof fullName === 'string') why.delete(fullName);
}

/**
 * The running head's Repos count: the number when repos are connected; on a
 * fresh home a figure held unseen, so the count keeps its room and Settings
 * and Find stand where they always do.
 */
export function repoCount(n: number): { text: string; shown: boolean } {
  return n > 0 ? { text: String(n), shown: true } : { text: '0', shown: false };
}
