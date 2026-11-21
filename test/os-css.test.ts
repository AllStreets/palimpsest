/**
 * The os layer's lints, over every .css and .ts under app/src/ui/os/: no
 * backdrop-filter, motion on transform and opacity only (in sheets, inline
 * styles and element.animate), no HTML parsing, and
 * animation none under prefers-reduced-motion for every animated class.
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

/** What a Web Animations keyframe may name besides the two cheap properties. */
const KEYFRAME_META = new Set(['offset', 'easing', 'composite']);
const KEYFRAME_CHEAP = new Set(['transform', 'opacity', 'strokeDashoffset']);

/** The argument text of a call opening at `open` (the index of its '('), up to the matching ')'. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(' || src[i] === '[' || src[i] === '{') depth++;
    if ((src[i] === ')' || src[i] === ']' || src[i] === '}') && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/**
 * Motion a .ts file sets up that the CSS lint cannot see: transitions set
 * inline, animations set inline (they belong in a sheet, where both lints
 * reach them), and element.animate() keyframes on anything but transform and
 * opacity. Setting style.transform is allowed: it is how panes move.
 */
function tsMotionFaults(raw: string): string[] {
  const src = uncomment(raw).replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const set = [...src.matchAll(/\.style\.transition(?:Property)?\s*=\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
  const prop = [...src.matchAll(/setProperty\(\s*(['"`])transition(?:-property)?\1\s*,\s*(['"`])([^'"`]*)\2/g)].map((m) => m[3]);
  const inline = [...src.matchAll(/transition(?:-property)?\s*:\s*([^;'"`]+)/g)].map((m) => m[1]);
  for (const list of [...set, ...prop, ...inline]) {
    for (const entry of topLevel(list)) if (!cheap(entry)) out.push(`transition "${entry}"`);
  }
  for (const m of src.matchAll(/\.style\.(animation\w*)\s*=\s*(['"`]?)([^'"`;\n]*)\2/g)) {
    if (m[2] && /^(none)?$/.test(m[3].trim())) continue;
    out.push(`sets style.${m[1]}; animate in a sheet`);
  }
  for (const m of src.matchAll(/setProperty\(\s*(['"`])(animation[\w-]*)\1/g)) out.push(`sets ${m[2]}; animate in a sheet`);
  for (const m of src.matchAll(/\.animate\s*\(/g)) {
    const args = callArgs(src, m.index! + m[0].length - 1).trim();
    if (!/^[[{]/.test(args)) {
      out.push(`animate() with keyframes the lint cannot read: ${args.slice(0, 30)}`);
      continue;
    }
    const frames = args[0] === '[' ? callArgs(args, 0) : `{${callArgs(args, 0)}}`;
    for (const k of frames.matchAll(/([A-Za-z_$][\w$]*|['"][\w-]+['"])\s*:/g)) {
      const key = k[1].replace(/['"]/g, '');
      if (!KEYFRAME_CHEAP.has(key) && !KEYFRAME_META.has(key)) out.push(`animate() keyframes move ${key}`);
    }
  }
  return out;
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
    for (const fault of tsMotionFaults(read(f))) assert.fail(`${name(f)}: ${fault}`);
  }
});

test('the .ts motion lint catches what it should and passes what it should', () => {
  const bad = [
    `el.style.transition = 'left 200ms';`,
    `el.style.setProperty('transition', 'width 1s');`,
    `el.style.animation = 'os-scan 1s';`,
    `el.style.animationName = 'spin';`,
    `el.style.setProperty('animation', 'spin 1s');`,
    `el.animate([{ left: '0px' }, { left: '10px' }], 300);`,
    `el.animate({ transform: ['none', 'scale(2)'], width: ['0', '1px'] }, { duration: 300 });`,
    `el.animate(frames, 300);`,
  ];
  for (const src of bad) assert.ok(tsMotionFaults(src).length > 0, `missed: ${src}`);
  const good = [
    `el.style.transform = 'translate(4px, 2px)';`,
    `el.style.transition = 'transform 240ms, opacity 140ms';`,
    `el.style.animation = 'none';`,
    `el.animate([{ transform: 'none', opacity: 0 }, { transform: 'translateX(4px)', opacity: 1, offset: 1, easing: 'ease' }], 300);`,
    `el.animate({ opacity: [0, 1] }, { duration: 300 });`,
    `node.textContent = text.slice(0, n);`,
  ];
  for (const src of good) assert.deepEqual(tsMotionFaults(src), [], `flagged: ${src}`);
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
  const missing = unansweredClasses(css.map((f) => ({ file: name(f), sheet: uncomment(read(f)) })), reduced);
  assert.deepEqual(missing, [], `animated with no animation: none under prefers-reduced-motion: ${missing.join(', ')}`);
});

const ANIMATION = /(?:^|;|\s)animation(?:-name)?\s*:\s*([^;]+)/;

/** The animated classes that no rule in the reduced-motion blocks stops with animation(-name): none. */
function unansweredClasses(sheets: Array<{ file: string; sheet: string }>, reduced: string): string[] {
  const stopped = new Set<string>();
  for (const [sel, body] of rules(reduced)) {
    const anim = ANIMATION.exec(body);
    if (!anim || !/^none\b/.test(anim[1].trim())) continue;
    for (const m of sel.matchAll(/\.([\w-]+)/g)) stopped.add(m[1]);
  }
  const out: string[] = [];
  for (const { file, sheet } of sheets) {
    const outside = sheet.replace(/@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const [sel, raw] of rules(outside)) {
      if (/^\s*(from|to|\d+%)/.test(sel)) continue;
      const anim = ANIMATION.exec(raw);
      if (!anim || /^none\b/.test(anim[1].trim())) continue;
      for (const cls of new Set([...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]))) if (!stopped.has(cls)) out.push(`${file} .${cls}`);
    }
  }
  return out;
}

test('the reduced-motion lint wants animation none on the same class, not a mention', () => {
  const sheet = `.a { animation: spin 1s; } .b { animation-name: spin; }`;
  assert.deepEqual(unansweredClasses([{ file: 'x.css', sheet }], `.a { opacity: 1; } .b { display: none; }`), ['x.css .a', 'x.css .b']);
  assert.deepEqual(unansweredClasses([{ file: 'x.css', sheet }], `.a { animation: none; } .b, .c { animation-name: none; }`), []);
  assert.deepEqual(unansweredClasses([{ file: 'x.css', sheet }], `.c { animation: none; } .a { animation: none; }`), ['x.css .b']);
});

/** Every comma-separated selector in a rule's selector list. */
const selectors = (sel: string): string[] => topLevel(sel);
/** Red, or any ink that reads as red: the red token, the fail token, or a colour set by hand. */
const RED = /var\(--os-red(?:-rgb)?\)/;
const REDDISH = /var\(--os-(?:red|fail)(?:-rgb)?\)/;

test('only the grant weight is red', () => {
  const sheet = uncomment(read(join(OS, 'control.css')));
  const all = rules(sheet).filter(([sel]) => !/^\s*(from|to|\d+%)/.test(sel));
  const grant = "[data-weight='grant']";
  // Every rule that names red names it for the grant alone, in every selector of its list.
  for (const [sel, body] of all) {
    if (!RED.test(body)) continue;
    for (const s of selectors(sel)) assert.ok(s.includes(grant), `control.css ${s} is red but not the grant`);
  }
  // The grant does use the red token, so the rule above is not passing on an empty sheet.
  assert.ok(
    all.some(([sel, body]) => sel.includes(grant) && RED.test(body)),
    'the grant is not drawn in var(--os-red)',
  );
  // And look, decide and spend each have rules, none of them red or fail, nor colour set by hand.
  for (const w of ['look', 'decide', 'spend']) {
    const own = all.filter(([sel]) => sel.includes(`[data-weight='${w}']`));
    assert.ok(own.length > 0, `control.css has no rules for ${w}`);
    for (const [sel, body] of own) assert.ok(!REDDISH.test(body), `control.css ${sel}: ${w} is red`);
  }
  // Colour comes from the tokens alone: no hex and no rgb() of numbers but black for shadows.
  for (const [sel, body] of all) {
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(body), `control.css ${sel} sets a colour by hex`);
    for (const m of body.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      assert.deepEqual([m[1], m[2], m[3]], ['0', '0', '0'], `control.css ${sel} sets rgb(${m[1]}, ${m[2]}, ${m[3]}) by hand`);
    }
  }
});

// ---------------------------------------------------------------- the terminal's one filter (Task 12)

/**
 * Every rule in the os sheets that blurs with a filter or transitions one, with its file. A still drop-shadow on
 * a small mark (the grant's ticks) is neither, and stays allowed.
 */
function filterRules(): Array<{ file: string; sel: string; raw: string }> {
  const out: Array<{ file: string; sel: string; raw: string }> = [];
  for (const f of css) {
    for (const [sel, raw] of rules(read(f))) {
      const body = uncomment(raw);
      const sets = /(?:^|;|\s)filter\s*:[^;]*blur\(/.test(body);
      const moves = [...body.matchAll(/(?:^|;|\s)transition(?:-property)?\s*:\s*([^;]+)/g)].some((m) => topLevel(m[1]).some((e) => /^filter\b/.test(e)));
      if (sets || moves || raw.includes(CITY_FILTER)) out.push({ file: name(f), sel, raw });
    }
  }
  return out;
}

test('the only blur and the only moving filter in the os layer are the terminal\'s, on the city host, in the one marked rule', () => {
  const found = filterRules();
  const marked = found.filter((r) => r.raw.includes(CITY_FILTER));
  assert.equal(marked.length, 1, `one rule carries ${CITY_FILTER}: ${marked.map((r) => `${r.file} ${r.sel}`).join(', ')}`);
  const [rule] = marked;
  assert.equal(rule.file, join('os', 'terminal.css'));
  assert.equal(rule.sel, "html[data-os-mode='terminal'] #city", 'the filter sits on the city host in terminal mode, not on a panel');
  const body = uncomment(rule.raw);
  assert.match(body, /(?:^|;|\s)filter:\s*blur\(6px\) brightness\(0\.3\) saturate\(0\.6\);/);
  // The marker rides on the transition line alone, and that transition moves the filter and nothing else.
  const line = rule.raw.split('\n').find((l) => l.includes(CITY_FILTER)) ?? '';
  assert.match(line, /^\s*transition:\s*filter\s/, `the marker is on the transition line: ${line.trim()}`);
  for (const m of body.matchAll(/(?:^|;|\s)transition(?:-property)?\s*:\s*([^;]+)/g)) {
    for (const e of topLevel(m[1])) assert.ok(/^filter\b/.test(e) || cheap(e), `the marked rule transitions "${e}"`);
  }
  // No other rule sets a filter or transitions one.
  for (const r of found) if (r !== rule) assert.fail(`${r.file} ${r.sel} blurs or transitions a filter outside the marked rule`);
  for (const f of ts) assert.ok(!/\.style\.filter\b|setProperty\(\s*['"`]filter/.test(uncomment(read(f))), `${name(f)} sets a filter from script`);
});

test('reduced motion takes the city filter\'s transition off: the still equivalent', () => {
  const sheet = uncomment(read(join(OS, 'terminal.css')));
  const reduced = blocks(sheet, /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/).map((b) => b.body).join('\n');
  const still = rules(reduced).find(([sel]) => sel === "html[data-os-mode='terminal'] #city");
  assert.ok(still, 'terminal.css answers the city filter under reduced motion');
  assert.match(still[1], /transition:\s*none/);
});

test('the terminal stands full height in the mono face, and index.css loads it', () => {
  const sheet = uncomment(read(join(OS, 'terminal.css')));
  const panel = rules(sheet).find(([sel]) => sel === '.os-terminal');
  assert.ok(panel, 'terminal.css has an .os-terminal rule');
  assert.match(panel[1], /top:\s*64px/);
  assert.match(panel[1], /bottom:\s*16px/);
  assert.match(panel[1], /font-family:\s*var\(--os-mono\)/);
  assert.match(panel[1], /color:\s*var\(--os-amber\)/);
  // Made today: no glow on the words, no scanlines.
  assert.ok(!/text-shadow|repeating-linear-gradient/.test(sheet), 'terminal.css draws a CRT glow or scanlines');
  assert.match(uncomment(read(join(OS, 'index.css'))), /@import '\.\/terminal\.css';/);
});
