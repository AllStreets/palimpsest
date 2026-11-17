import type { BriefAction, BriefItem } from './types.js';

/** The actions that settle a brief item: after one, nothing on the row waits for him. */
export const FINISHING: readonly BriefAction[] = ['accept', 'dismiss', 'retry', 'resume', 'audit', 'grant', 'decline', 'revoke'];

/** Whether he has settled the item (posted, dismissed, retried...): a tier changed or a limit set still waits. */
export function briefHandled(item: Pick<BriefItem, 'acted'>): boolean {
  return item.acted !== null && FINISHING.includes(item.acted.action);
}
