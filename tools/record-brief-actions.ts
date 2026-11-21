/**
 * Records the Brief's action contract from main's own code, once (screens
 * redesign Task 14): which branch of actionNode each action takes, which
 * actions the Brief records as a look(), and the engine's LOOKS. The result,
 * tools/fixtures/brief-actions.json, is what test/brief-actions.test.ts holds
 * the new action table to, so the table is never compared with itself.
 *
 * It reads origin/main through git (`git show`), never this branch's files:
 *
 *   node --no-warnings --import tsx tools/record-brief-actions.ts [ref]
 *
 * The ref defaults to origin/main. Re-recording is a deliberate act: the
 * fixture is main's contract, and the rebuild must reproduce it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'fixtures', 'brief-actions.json');

const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`record-brief-actions: "${start}" not found`);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`record-brief-actions: "${end}" not found after "${start}"`);
  return src.slice(i, j);
}

const quoted = (list: string): string[] => [...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

export interface BriefActionsFixture {
  ref: string;
  commit: string;
  /** Every BriefAction, in the union's order. */
  actions: string[];
  /** The branch of actionNode each action takes: its own branch by name, or 'act' for the switch's default, act(item, a). */
  effect: Record<string, string>;
  /** The actions the Brief records with look(), from its look(item, '...') calls. */
  uiLooks: string[];
  /** The engine's LOOKS in engine/brief.ts. */
  engineLooks: string[];
}

export function record(ref = 'origin/main'): BriefActionsFixture {
  const commit = git('rev-parse', ref).trim();
  const types = git('show', `${commit}:shared/types.ts`);
  const ui = git('show', `${commit}:app/src/ui/brief.ts`);
  const engine = git('show', `${commit}:engine/brief.ts`);

  const union = /export type BriefAction =([^;]+);/.exec(types);
  if (!union) throw new Error('record-brief-actions: no BriefAction union in shared/types.ts');
  const actions = quoted(union[1]);

  const node = between(ui, 'function actionNode(', 'function capField(');
  const own = new Set<string>();
  for (const m of node.matchAll(/if \(a === '([a-z-]+)'\) \{\s*\n\s*if \(!isGithub/g)) own.add(m[1]);
  const sw = between(node, 'switch (a) {', '\n    });');
  for (const m of sw.matchAll(/case '([a-z-]+)':/g)) own.add(m[1]);
  const dflt = /default:\s*\n\s*return void act\(item, a\);/.test(sw);
  if (!dflt) throw new Error("record-brief-actions: the switch's default is not act(item, a)");
  for (const a of own) if (!actions.includes(a)) throw new Error(`record-brief-actions: branch for unknown action ${a}`);
  const effect: Record<string, string> = {};
  for (const a of actions) effect[a] = own.has(a) ? a : 'act';

  const uiLooks = [...new Set([...ui.matchAll(/look\(item, '([a-z-]+)'\)/g)].map((m) => m[1]))].sort();
  const looks = /const LOOKS: readonly BriefAction\[\] = \[([^\]]*)\];/.exec(engine);
  if (!looks) throw new Error('record-brief-actions: no LOOKS in engine/brief.ts');
  return { ref, commit, actions, effect, uiLooks, engineLooks: quoted(looks[1]) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const f = record(process.argv[2]);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(f, null, 2)}\n`);
  console.log(`record-brief-actions: ${f.actions.length} actions from ${f.ref} (${f.commit.slice(0, 7)}) into ${OUT}`);
}
