/**
 * The house rules every diagram label is held to (Global Constraints): no
 * em dash, no double hyphen, no emoji, and sentence case. A `code` label
 * (a command, a host, a ledger kind) is set as the code spells it and is
 * held only to the first three.
 */
import type { Label } from './sheet.js';

/** Names that keep their capitals mid-sentence. */
const PROPER = new Set([
  'Palimpsest',
  'Claude',
  'Ollama',
  'SQLite',
  'GitHub',
  'MLX',
  'LoRA',
  'Qwen',
  'Beagle',
  'Mac',
  'macOS',
  'Tauri',
  'Brier',
  'Python',
  'Metal',
  'Node',
  'README',
  'UI',
  'CLI',
  'API',
  'HTTP',
  'PR',
  'I',
]);

const STRIP = /^[^\p{L}\p{N}~.]+|[^\p{L}\p{N}]+$/gu;

export function labelProblems(l: Label): string[] {
  const out: string[] = [];
  if (/—/.test(l.text)) out.push('an em dash');
  if (/--/.test(l.text)) out.push('a double hyphen');
  if (/\p{Extended_Pictographic}/u.test(l.text)) out.push('an emoji');
  if (l.kind === 'code') return out;
  const words = l.text.split(/\s+/).filter(Boolean);
  const first = words[0]?.replace(STRIP, '') ?? '';
  const startsLower = /^\p{Ll}/u.test(first);
  // A label may open on a code word (sudo, launchctl, gh, ~/.ssh) or a number; a plain word opens in capitals.
  if (startsLower && !CODEISH.test(first)) out.push(`case: "${first}" should open in capitals`);
  words.forEach((raw, i) => {
    const w = raw.replace(STRIP, '');
    if (!w) return;
    const prev = i > 0 ? words[i - 1] : '';
    const afterStop = /[.:?!]$/.test(prev);
    if (/^\p{Lu}{2,}$/u.test(w) && !PROPER.has(w)) out.push(`case: "${w}" is in capitals`);
    else if (i > 0 && !afterStop && /^\p{Lu}/u.test(w) && !PROPER.has(w) && !PROPER.has(w.replace(/[’']s$/, ''))) out.push(`case: "${w}" is title case`);
  });
  return out;
}

/** Words that are code, so they keep their own case at the head of a label. */
const CODEISH = /^(sudo|launchctl|osascript|security|gh|git|claude|sandbox-exec|mlx_lm\.server|school\.py|npm|launchd|~\/.*|\.\S+|\d.*|[a-z0-9-]+(\.[a-z0-9-]+)+)$/;
