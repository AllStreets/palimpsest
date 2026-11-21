/**
 * The Brief's action contract (screens redesign Task 14): what each action
 * does when he presses it. These decisions teach his master net, so the
 * rebuild keeps every one: the table is main's actionNode switch exactly,
 * held to tools/fixtures/brief-actions.json (recorded from main) by
 * test/brief-actions.test.ts.
 *
 * One table keyed by BriefAction: each action's effect, weight, label and
 * acted words are fields of its row here (Task 16), never tables beside it.
 */
import { LOOKS } from '../../../shared/brief-actions.js';
import { AGREE } from '../../../shared/school-rules.js';
import type { BriefAction } from '../../../shared/types.js';
import type { Weight } from './os/control.js';

export { LOOKS };

/**
 * What a press does: 'act' is act(item, a), the call that waits on the
 * engine's answer; each other effect is that action's own branch in
 * actionNode (Ask why unfolds and records a look, Fly there flies and
 * records one, and so on).
 */
export type Effect = 'act' | 'why' | 'tier' | 'cap' | 'diff' | 'fly' | 'tour' | 'open-pr';

/**
 * One action's row: what a press does, the key's weight by consequence
 * (Global Constraints: grant, spend, decide, look), its short label, and,
 * for an action that changes something, what the row says once he did it
 * ("Posted 09:14"). Tier and today's limit say their new value instead
 * (brief-words.ts actedLine), and looks leave no line.
 */
export interface ActionRow {
  readonly effect: Effect;
  readonly weight: Weight;
  readonly label: string;
  readonly done?: string;
}

/**
 * A row. Every action the Brief records as a look (shared LOOKS) is a look
 * key, read from LOOKS rather than written out again; any other action
 * names its own weight.
 */
function row(a: BriefAction, effect: Effect, label: string, rest: { weight?: Weight; done?: string } = {}): ActionRow {
  const weight = LOOKS.includes(a) ? 'look' : rest.weight;
  if (!weight) throw new Error(`brief action ${a} has no weight`);
  return Object.freeze({ effect, weight, label, ...(rest.done ? { done: rest.done } : {}) });
}

export const ACTIONS: Readonly<Record<BriefAction, ActionRow>> = Object.freeze({
  accept: row('accept', 'act', 'Post', { weight: 'spend', done: 'Posted' }),
  // A tier change ranks with spending: it sets what the post may cost (ruling, spec over plan).
  tier: row('tier', 'tier', 'Tier', { weight: 'spend' }),
  dismiss: row('dismiss', 'act', 'Dismiss', { weight: 'decide', done: 'Dismissed' }),
  why: row('why', 'why', 'Why'),
  diff: row('diff', 'diff', 'Diff'),
  fly: row('fly', 'fly', 'Fly there'),
  retry: row('retry', 'act', 'Retry', { weight: 'spend', done: 'Posted again' }),
  resume: row('resume', 'act', 'Resume', { weight: 'spend', done: 'Resumed' }),
  'open-pr': row('open-pr', 'open-pr', 'Open PR'),
  cap: row('cap', 'cap', 'Set limit', { weight: 'spend' }),
  audit: row('audit', 'act', 'Audit', { weight: 'spend', done: 'Audit queued' }),
  tour: row('tour', 'tour', 'Walk the week', { weight: 'look', done: 'Walked' }),
  // Phase 4: an ask for autonomy, and an act under a grant.
  grant: row('grant', 'act', 'Let it act here', { weight: 'grant', done: 'Granted' }),
  decline: row('decline', 'act', 'Not yet', { weight: 'decide', done: `Not yet, quiet ${AGREE.quietDays} days` }),
  revoke: row('revoke', 'act', 'Take back', { weight: 'decide', done: 'Taken back' }),
});

/** Each action's effect, read from its row in ACTIONS. */
export const EFFECT: Readonly<Record<BriefAction, Effect>> = Object.freeze(
  Object.fromEntries(Object.entries(ACTIONS).map(([a, row]) => [a, row.effect])) as Record<BriefAction, Effect>,
);
