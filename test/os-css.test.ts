/**
 * The os layer's lints, over every .css and .ts under app/src/ui/os/: no
 * backdrop-filter, motion on transform and opacity only, no HTML parsing, and
 * a reduced-motion answer for every animated rule.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui');
const OS = join(UI, 'os');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(OS).filter((f) => f.endsWith('.css') || f.endsWith('.ts'));
const read = (f: string): string => readFileSync(f, 'utf8');
const name = (f: string): string => relative(UI, f);
const css = files.filter((f) => f.endsWith('.css'));
const ts = files.filter((f) => f.endsWith('.ts'));
const uncomment = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** The marker on the one rule allowed to transition something else: the terminal's filter on the city host. */
const CITY_FILTER = '/* os: city-filter */';

/** Splits a list on its top-level commas, leaving those inside cubic-bezier() alone. */
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The innermost rules of a sheet as [selector, raw body], comments kept in the body. */
const rules = (sheet: string): Array<[string, string]> => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [uncomment(m[1]).trim(), m[2]]);

/** The body of each brace block whose prelude matches, nested blocks included. */
function blocks(sheet: string, prelude: RegExp): Array<{ head: string; body: string }> {
  const out: Array<{ head: string; body: string }> = [];
  const re = new RegExp(prelude.source, 'g');
  for (const m of sheet.matchAll(re)) {
    const open = sheet.indexOf('{', m.index! + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < sheet.length; i++) {
      if (sheet[i] === '{') depth++;
      if (sheet[i] === '}' && --depth === 0) {
        out.push({ head: m[0], body: sheet.slice(open + 1, i) });
        break;
      }
    }
  }
  return out;
}

/** Whether one transition entry moves only what the compositor moves: transform, opacity, or visibility flipped at 0s. */
function cheap(entry: string): boolean {
  const [prop, ...rest] = entry.trim().split(/\s+/);
  if (prop === 'none' || prop === 'transform' || prop === 'opacity') return true;
  return prop === 'visibility' && (rest.length === 0 || /^0m?s$/.test(rest[0]));
}

test('there are os files to lint', () => {
  assert.ok(css.some((f) => f.endsWith('tokens.css')), 'tokens.css is linted');
  assert.ok(ts.some((f) => f.endsWith('tokens.ts')), 'tokens.ts is linted');
});

test('no backdrop-filter', () => {
  for (const f of files) assert.ok(!/backdrop-filter/i.test(uncomment(read(f))), `${name(f)} uses backdrop-filter`);
});

test('transitions and animations move transform or opacity only', () => {
  for (const f of css) {
    const sheet = read(f);
    for (const [sel, raw] of rules(sheet)) {
      if (raw.includes(CITY_FILTER)) continue;
      const body = uncomment(raw);
      for (const m of body.matchAll(/(?:^|;|\s)transition(?:-property)?\s*:\s*([^;]+)/g)) {
        for (const entry of topLevel(m[1])) assert.ok(cheap(entry), `${name(f)} ${sel}: transition "${entry}"`);
      }
    }
    for (const { head, body } of blocks(uncomment(sheet), /@keyframes\s+[\w-]+\s*\{/)) {
      for (const [, frame] of rules(body)) {
        for (const decl of frame.split(';')) {
          const prop = decl.split(':')[0].trim();
          if (!prop) continue;
          assert.ok(['transform', 'opacity', 'stroke-dashoffset'].includes(prop), `${name(f)} ${head.trim()} sets ${prop}`);
        }
      }
    }
  }
  for (const f of ts) {
    const src = uncomment(read(f));
    const set = [...src.matchAll(/\.style\.transition(?:Property)?\s*=\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
    const inline = [...src.matchAll(/transition(?:-property)?\s*:\s*([^;'"`]+)/g)].map((m) => m[1]);
    for (const list of [...set, ...inline]) {
      for (const entry of topLevel(list)) assert.ok(cheap(entry), `${name(f)}: transition "${entry}"`);
    }
  }
});

test('no HTML parsing in the os layer or the Brief', () => {
  for (const f of [...ts, join(UI, 'brief.ts')]) {
    assert.ok(!/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(read(f)), `${name(f)} parses HTML; set text with textContent`);
  }
});

test('every animated rule has a reduced-motion answer', () => {
  const sheets = css.map((f) => uncomment(read(f))).join('\n');
  const reduced = blocks(sheets, /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/)
    .map((b) => b.body)
    .join('\n');
  for (const f of css) {
    for (const [sel, raw] of rules(uncomment(read(f)))) {
      const anim = /(?:^|;|\s)animation(?:-name)?\s*:\s*([^;]+)/.exec(raw);
      if (!anim || /^none\b/.test(anim[1].trim())) continue;
      for (const cls of new Set([...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]))) {
        assert.ok(new RegExp(`\\.${cls}(?![\\w-])`).test(reduced), `${name(f)} animates .${cls} with no prefers-reduced-motion answer`);
      }
    }
  }
});
