/**
 * The nets' fixed feature lists and their encoder (Phase 4, ruling 8). Pure:
 * no engine import, so the engine's rows, the trainer's weights and the
 * school screen name the same columns in the same order.
 *
 * A raw row is a plain record of named values. A number field is its value;
 * a nullable one is followed by a `has_<name>` mask, 1 when the value is
 * known and 0 (with the value 0) when it is not. A one-hot field becomes one
 * column per value, `<name>=<value>`; a value outside the list, or none, is
 * all zeros. Every encoded value is a finite number.
 */
import { WORK_KINDS } from './school-rules.js';
import type { BriefItemKind, Era, JobSource, NetName, Tier, WorkflowShape } from './types.js';

type Field = { name: string; kind: 'num'; nullable?: boolean } | { name: string; kind: 'one'; values: readonly string[] };

const num = (name: string, nullable = false): Field => ({ name, kind: 'num', nullable });
const one = (name: string, values: readonly string[]): Field => ({ name, kind: 'one', values });

export const TIER_VALUES: readonly Tier[] = ['low', 'normal', 'high'];
export const SOURCE_VALUES: readonly JobSource[] = ['issue', 'manual', 'harness', 'proposal', 'brief'];
/** A repo's language, as GitHub names it; anything else is `other`. */
export const LANGUAGE_VALUES = ['TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Swift', 'other'] as const;
export const SHAPE_VALUES: readonly WorkflowShape[] = ['single', 'plan-then-answer', 'self-check', 'vote'];
/** A model's family: the backend before the colon of its ref. */
export const FAMILY_VALUES = ['claude', 'anthropic', 'ollama', 'mlx'] as const;
export const ERA_VALUES: readonly Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
export const BRIEF_KIND_VALUES: readonly BriefItemKind[] = ['merged', 'failed', 'pr', 'proposal', 'halt', 'revert', 'note', 'audit', 'audit-due', 'usage', 'stale', 'milestone', 'tour', 'autonomy', 'graduate', 'acted'];
export const WEEKDAY_VALUES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** The job, repo and agent half the appraiser and the router share. */
const JOB_FIELDS: readonly Field[] = [
  one('tier', TIER_VALUES),
  num('scope_globs'),
  num('acceptance_lines'),
  one('source', SOURCE_VALUES),
  one('language', LANGUAGE_VALUES),
  num('checks_known'),
  num('check_test'),
  num('check_typecheck'),
  num('check_lint'),
  num('check_build'),
  num('check_screenshot'),
];
const AGENT_FIELDS: readonly Field[] = [one('workflow', SHAPE_VALUES), one('model_family', FAMILY_VALUES), one('era', ERA_VALUES), num('firm_pass_rate', true), num('firm_brier', true)];
const APPRAISER: readonly Field[] = [...JOB_FIELDS, num('price_over_value', true), num('confidence'), num('plan_words'), ...AGENT_FIELDS];

/** Every net's raw fields, in column order. */
export const FIELDS: Record<NetName, readonly Field[]> = {
  'appraiser-pass': APPRAISER,
  'appraiser-cost': APPRAISER,
  router: [...JOB_FIELDS, ...AGENT_FIELDS],
  durability: [
    num('diff_files'),
    num('diff_lines', true),
    one('tier', TIER_VALUES),
    one('model_family', FAMILY_VALUES),
    num('checks_passed'),
    num('preexisting'),
    num('design_checked'),
    num('review_concerns'),
    num('his_changes'),
  ],
  triage: [
    one('kind', BRIEF_KIND_VALUES),
    one('tier', TIER_VALUES),
    num('hours_since_at', true),
    one('weekday', WEEKDAY_VALUES),
    num('first_open_hour'),
    num('position'),
    num('repo_accept_share', true),
  ],
  taste: [num('after'), num('before', true), num('difference', true), num('diff_only'), num('shots'), num('pair')],
  master: [
    num('appraiser', true),
    num('router', true),
    num('durability', true),
    num('triage', true),
    num('taste', true),
    one('kind', WORK_KINDS),
    num('repo_approval_share', true),
  ],
};

function columns(fields: readonly Field[]): string[] {
  return fields.flatMap((f) => (f.kind === 'one' ? f.values.map((v) => `${f.name}=${v}`) : f.nullable ? [f.name, `has_${f.name}`] : [f.name]));
}

/** Every net's encoded columns, in order: what `encode` returns and the trainer's `features`. */
export const FEATURES: Record<NetName, readonly string[]> = {
  'appraiser-pass': columns(FIELDS['appraiser-pass']),
  'appraiser-cost': columns(FIELDS['appraiser-cost']),
  router: columns(FIELDS.router),
  durability: columns(FIELDS.durability),
  triage: columns(FIELDS.triage),
  taste: columns(FIELDS.taste),
  master: columns(FIELDS.master),
};

/** A raw row: each field's value by name; missing, null or not finite means unknown. */
export type RawRow = Record<string, number | string | boolean | null | undefined>;

function known(v: RawRow[string]): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `raw` as the net's columns: one-hots for lists, `has_*` masks for nullable numbers, 0 for anything unknown. */
export function encode(net: NetName, raw: RawRow): number[] {
  const x: number[] = [];
  for (const f of FIELDS[net]) {
    const v = raw[f.name];
    if (f.kind === 'one') {
      for (const value of f.values) x.push(v === value ? 1 : 0);
      continue;
    }
    const n = known(v);
    x.push(n ?? 0);
    if (f.nullable) x.push(n === null ? 0 : 1);
  }
  return x;
}
