/**
 * The Brief's action contract (screens redesign Task 14): what each action
 * does when he presses it. These decisions teach his master net, so the
 * rebuild keeps every one: the table is main's actionNode switch exactly,
 * held to tools/fixtures/brief-actions.json (recorded from main) by
 * test/brief-actions.test.ts.
 *
 * One table keyed by BriefAction. Later tasks add each action's weight and
 * label as fields of its row here, never as tables beside it.
 */
import { LOOKS } from '../../../shared/brief-actions.js';
import type { BriefAction } from '../../../shared/types.js';

export { LOOKS };

/**
 * What a press does: 'act' is act(item, a), the call that waits on the
 * engine's answer; each other effect is that action's own branch in
 * actionNode (Ask why unfolds and records a look, Fly there flies and
 * records one, and so on).
 */
export type Effect = 'act' | 'why' | 'tier' | 'cap' | 'diff' | 'fly' | 'tour' | 'open-pr';

export interface ActionRow {
  readonly effect: Effect;
}

export const ACTIONS: Readonly<Record<BriefAction, ActionRow>> = Object.freeze({
  accept: { effect: 'act' },
  tier: { effect: 'tier' },
  dismiss: { effect: 'act' },
  why: { effect: 'why' },
  diff: { effect: 'diff' },
  fly: { effect: 'fly' },
  retry: { effect: 'act' },
  resume: { effect: 'act' },
  'open-pr': { effect: 'open-pr' },
  cap: { effect: 'cap' },
  audit: { effect: 'act' },
  tour: { effect: 'tour' },
  grant: { effect: 'act' },
  decline: { effect: 'act' },
  revoke: { effect: 'act' },
});

/** Each action's effect, read from its row in ACTIONS. */
export const EFFECT: Readonly<Record<BriefAction, Effect>> = Object.freeze(
  Object.fromEntries(Object.entries(ACTIONS).map(([a, row]) => [a, row.effect])) as Record<BriefAction, Effect>,
);
