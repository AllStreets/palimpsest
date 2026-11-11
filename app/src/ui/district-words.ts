/**
 * The district page's words (Task 40), kept apart from its DOM so they can be
 * tested: where a check came from, and which screenshot routes it accepts.
 */
import type { CheckField, RepoChecks } from '../../../shared/types.js';

/** A route to shoot: a path from the site's root, with no space, control character or backslash (as the engine accepts it). */
const ROUTE = /^\/[^\x00-\x1f\x7f\s\\]{0,199}$/;

export function isRoute(v: string): boolean {
  return ROUTE.test(v);
}

/**
 * Where a check came from: none when it is empty (whoever emptied it), set
 * by you when he changed it, else detected. Checks set by hand before the
 * engine kept track of each one read as set by you.
 */
export function sourceOf(checks: RepoChecks | null, field: CheckField): 'set by you' | 'detected' | 'none' {
  const v = checks?.[field];
  const has = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
  if (!has) return 'none';
  if (checks?.setByYou?.includes(field)) return 'set by you';
  return checks?.detected === false && !checks.setByYou ? 'set by you' : 'detected';
}
