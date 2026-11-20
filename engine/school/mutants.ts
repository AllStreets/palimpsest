/**
 * Planted bugs (Phase 4 ruling 20): one-line mutants of a source file, each
 * a single change to code (never to a string, a template's text or a
 * comment), from six kinds of bug:
 *
 * - `comparison`: flip a comparison (`<` to `>=`, `===` to `!==`, ...);
 *   only one written with a space on each side, so a generic, an arrow, a
 *   shift or a tag is never taken for one;
 * - `off-by-one`: an integer literal one more;
 * - `logic`: swap `&&` and `||` (`and` and `or` in Python);
 * - `negation`: drop a `!`;
 * - `boolean`: swap `true` and `false` (`True` and `False` in Python);
 * - `first-arg`: a one-line `return` of the enclosing function returns its
 *   first argument instead.
 *
 * `mutate()` is pure and deterministic: the same path, text and seed give
 * the same mutants in the same order. Test files and files that are not
 * code are never mutated.
 */
import { isTestFile } from '../audit/schema.js';

export type MutantOp = 'comparison' | 'off-by-one' | 'logic' | 'negation' | 'boolean' | 'first-arg';

export interface Mutant {
  /** The file, relative to the repo root. */
  file: string;
  /** 1-based. */
  line: number;
  /** The line as the repo has it. */
  original: string;
  /** The line with the bug planted. */
  mutated: string;
  op: MutantOp;
}

type Lang = 'js' | 'c' | 'go' | 'py' | 'rb';

const LANGS: Record<string, Lang> = {
  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  java: 'c', kt: 'c', kts: 'c', scala: 'c', swift: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c',
  cs: 'c', php: 'c', dart: 'c', rs: 'c', m: 'c', mm: 'c',
  go: 'go',
  py: 'py',
  rb: 'rb',
};

/** The language of a file whose code `mutate()` can read, or null. */
export function langOf(path: string): Lang | null {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return LANGS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** True when `mutate()` may plant bugs in `path`: code it can read, and not a test. */
export function mutable(path: string): boolean {
  return langOf(path) !== null && !isTestFile(path);
}

// ---------------------------------------------------------------- what is code

/** True when a `/` at `i` begins a regex: the previous significant token is not an operand. */
function regexAllowed(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j--;
  if (j < 0 || text[j] === '\n') return true;
  const p = text[j];
  if ('(,=:[!&|?{;+-*%<>~^'.includes(p)) return true;
  if (/[\w$]/.test(p)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(text[k])) k--;
    return text.slice(k + 1, j + 1) === 'return';
  }
  return false;
}

/** Index of the last character (flags included) of the regex literal starting at `i`, or -1 if the line holds no closing `/`. */
function regexEnd(text: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < text.length && text[k] !== '\n'; k++) {
    const c = text[k];
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let e = k;
      while (/[A-Za-z]/.test(text[e + 1] ?? '')) e++;
      return e;
    }
  }
  return -1;
}

/**
 * For each line, which characters are code: false inside a string, a
 * template's text or a comment. A template's `${...}` is code.
 */
export function codeMask(text: string, lang: Lang): boolean[][] {
  const hashComments = lang === 'py' || lang === 'rb';
  const slashComments = !hashComments;
  const out: boolean[][] = [[]];
  type State = { kind: 'code' } | { kind: 'line' } | { kind: 'block' } | { kind: 'str'; q: string } | { kind: 'triple'; q: string } | { kind: 'tpl' } | { kind: 'raw' };
  let s: State = { kind: 'code' };
  /** Brace depth of each open `${` (innermost last). */
  const holes: number[] = [];
  const mark = (code: boolean) => out[out.length - 1].push(code);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1] ?? '';
    if (c === '\n') {
      out.push([]);
      if (s.kind === 'line') s = { kind: 'code' };
      // A quoted string never spans lines (an unclosed one ends here, as far as the mask goes).
      if (s.kind === 'str') s = { kind: 'code' };
      continue;
    }
    switch (s.kind) {
      case 'code': {
        if (slashComments && c === '/' && next === '/') {
          s = { kind: 'line' };
          mark(false);
        } else if (slashComments && c === '/' && next === '*') {
          s = { kind: 'block' };
          mark(false);
          mark(false);
          i++;
        } else if (lang === 'js' && c === '/' && regexAllowed(text, i) && regexEnd(text, i) > i) {
          const end = regexEnd(text, i);
          for (let k = i; k <= end; k++) mark(false);
          i = end;
        } else if (hashComments && c === '#') {
          s = { kind: 'line' };
          mark(false);
        } else if (lang === 'py' && (c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
          s = { kind: 'triple', q: c };
          mark(false);
          mark(false);
          mark(false);
          i += 2;
        } else if (c === '"' || c === "'") {
          s = { kind: 'str', q: c };
          mark(false);
        } else if (c === '`' && lang === 'js') {
          s = { kind: 'tpl' };
          mark(false);
        } else if (c === '`' && lang === 'go') {
          s = { kind: 'raw' };
          mark(false);
        } else {
          if (holes.length && c === '{') holes[holes.length - 1]++;
          if (holes.length && c === '}') {
            if (holes[holes.length - 1] === 0) {
              holes.pop();
              s = { kind: 'tpl' };
              mark(false);
              break;
            }
            holes[holes.length - 1]--;
          }
          mark(true);
        }
        break;
      }
      case 'line':
        mark(false);
        break;
      case 'block':
        mark(false);
        if (c === '*' && next === '/') {
          mark(false);
          i++;
          s = { kind: 'code' };
        }
        break;
      case 'str':
        mark(false);
        if (c === '\\' && next !== '\n' && next !== '') {
          mark(false);
          i++;
        } else if (c === s.q) s = { kind: 'code' };
        break;
      case 'triple':
        mark(false);
        if (c === '\\' && next !== '\n' && next !== '') {
          mark(false);
          i++;
        } else if (text.startsWith(s.q.repeat(3), i)) {
          mark(false);
          mark(false);
          i += 2;
          s = { kind: 'code' };
        }
        break;
      case 'tpl':
        mark(false);
        if (c === '\\' && next !== '\n' && next !== '') {
          mark(false);
          i++;
        } else if (c === '$' && next === '{') {
          mark(false);
          i++;
          holes.push(0);
          s = { kind: 'code' };
        } else if (c === '`') s = { kind: 'code' };
        break;
      case 'raw':
        mark(false);
        if (c === '`') s = { kind: 'code' };
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the six bugs

const FLIP: Record<string, string> = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<=': '>', '>=': '<', '<': '>=', '>': '<=',
};
const COMPARISONS = ['===', '!==', '<=', '>=', '==', '!=', '<', '>'];

const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Whether `[at, at + len)` of the line is code. */
const inCode = (mask: boolean[], at: number, len: number) => {
  for (let k = at; k < at + len; k++) if (!mask[k]) return false;
  return true;
};

const replaceAt = (line: string, at: number, len: number, by: string) => line.slice(0, at) + by + line.slice(at + len);

/** Every single-site change of the six kinds on one line, in the order found. */
function lineMutants(line: string, mask: boolean[], lang: Lang): Array<{ mutated: string; op: MutantOp }> {
  const out: Array<{ mutated: string; op: MutantOp }> = [];
  const py = lang === 'py';

  // comparison: written with a space each side, and nothing of an operator either side
  for (let i = 0; i < line.length; i++) {
    if (line[i - 1] !== ' ') continue;
    const op = COMPARISONS.find((o) => line.startsWith(o, i));
    if (!op || line[i + op.length] !== ' ' || !inCode(mask, i, op.length)) continue;
    if (py && (op === '===' || op === '!==')) continue;
    out.push({ mutated: replaceAt(line, i, op.length, FLIP[op]), op: 'comparison' });
    i += op.length - 1;
  }

  // off by one: a whole integer literal, never part of a name or a decimal
  for (const m of line.matchAll(/\d+/g)) {
    const at = m.index ?? 0;
    const text = m[0];
    const before = line[at - 1];
    const after = line[at + text.length];
    if (isIdent(before) || before === '.' || isIdent(after) || after === '.' || text.length > 9) continue;
    if (!inCode(mask, at, text.length)) continue;
    out.push({ mutated: replaceAt(line, at, text.length, String(Number(text) + 1)), op: 'off-by-one' });
  }

  // logic: && and || (and and or in Python), spaced
  const logic: Array<[string, string]> = py ? [[' and ', ' or '], [' or ', ' and ']] : [[' && ', ' || '], [' || ', ' && ']];
  for (const [from, to] of logic) {
    for (let at = line.indexOf(from); at >= 0; at = line.indexOf(from, at + 1)) {
      if (inCode(mask, at, from.length)) out.push({ mutated: replaceAt(line, at, from.length, to), op: 'logic' });
    }
  }

  // negation: a prefix ! before a name or a bracket (never != or a non-null assertion)
  if (!py) {
    for (let at = line.indexOf('!'); at >= 0; at = line.indexOf('!', at + 1)) {
      const next = line[at + 1];
      if (!(isIdent(next) || next === '(') || isIdent(line[at - 1]) || line[at - 1] === ')' || line[at - 1] === ']') continue;
      if (inCode(mask, at, 1)) out.push({ mutated: replaceAt(line, at, 1, ''), op: 'negation' });
    }
  }

  // boolean: true and false
  const [t, f] = py ? ['True', 'False'] : ['true', 'false'];
  for (const m of line.matchAll(new RegExp(`\\b(${t}|${f})\\b`, 'g'))) {
    const at = m.index ?? 0;
    if (isIdent(line[at - 1]) || line[at - 1] === '.' || !inCode(mask, at, m[0].length)) continue;
    out.push({ mutated: replaceAt(line, at, m[0].length, m[0] === t ? f : t), op: 'boolean' });
  }
  return out;
}

/** The first parameter of a function header on this line, if the line has one. */
function firstParam(line: string, lang: Lang): string | null {
  const headers = lang === 'py'
    ? [/\bdef\s+\w+\s*\(([^)]*)\)/]
    : lang === 'rb'
      ? [/\bdef\s+[\w.?!]+\s*\(([^)]*)\)/]
      : lang === 'go'
        ? [/\bfunc\s+(?:\([^)]*\)\s*)?\w+\s*\(([^)]*)\)/]
        : [
            /\bfunction\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)/,
            /\(([^()]*)\)\s*(?::\s*[^=]+?)?\s*=>/,
            /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)*[\w$]+\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{\s*$/,
          ];
  for (const re of headers) {
    const m = re.exec(line);
    if (!m) continue;
    const params = m[1].split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of params) {
      if (lang === 'py' && (p === 'self' || p === 'cls')) continue;
      if (/^[[{(]/.test(p)) return null;
      const name = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? null;
      if (!name) return null;
      if (lang === 'go') return /^[A-Za-z_]\w*$/.test(name) ? name : null;
      return name;
    }
    return null;
  }
  return null;
}

/** A one-line `return <expr>` made to return the enclosing function's first argument. */
function firstArgMutant(lines: string[], masks: boolean[][], idx: number, lang: Lang): string | null {
  const line = lines[idx];
  const m = /^(\s*)return\s+(.+?)(;?)\s*$/.exec(line);
  if (!m) return null;
  const at = m[1].length;
  if (!inCode(masks[idx] ?? [], at, 6)) return null;
  const expr = m[2];
  // One whole expression on this line: brackets balanced, and the line not continued below.
  let depth = 0;
  for (const c of expr) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth < 0) return null;
  }
  if (depth !== 0 || /[,+\-*/&|?:.=([{\\]$/.test(expr.trim())) return null;
  for (let j = idx - 1; j >= 0 && j >= idx - 60; j--) {
    const p = firstParam(lines[j], lang);
    if (p === null) continue;
    if (p === expr.trim()) return null;
    return `${m[1]}return ${p}${m[3]}`;
  }
  return null;
}

// ---------------------------------------------------------------- the seeded order

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, the same on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `xs` in a seeded order (Fisher-Yates); the input is not changed. */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  const rand = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Up to `max` one-line mutants of `text` (the file at `path`), in an order
 * seeded by `seed` and the path. Pure: the same arguments, the same list.
 * Nothing for a test file or a file that is not code.
 */
export function mutate(path: string, text: string, max: number, seed: number): Mutant[] {
  const lang = langOf(path);
  if (!lang || isTestFile(path) || max <= 0) return [];
  const lines = text.split('\n');
  const masks = codeMask(text, lang);
  const found: Mutant[] = [];
  const seen = new Set<string>();
  const add = (idx: number, mutated: string, op: MutantOp) => {
    const original = lines[idx];
    const key = `${idx}\n${mutated}`;
    if (mutated === original || seen.has(key)) return;
    seen.add(key);
    found.push({ file: path, line: idx + 1, original, mutated, op });
  };
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || /^(import|export\s+\*|export\s+\{[^}]*\}\s+from|from\s+\S+\s+import|#include|package|use)\b/.test(trimmed)) continue;
    if (line.length > 400) continue;
    for (const m of lineMutants(line, masks[idx] ?? [], lang)) add(idx, m.mutated, m.op);
    const ret = firstArgMutant(lines, masks, idx, lang);
    if (ret) add(idx, ret, 'first-arg');
  }
  return shuffled(found, (hash32(path) ^ seed) >>> 0).slice(0, max);
}
