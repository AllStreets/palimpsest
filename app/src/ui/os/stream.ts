/**
 * The stream behind the panel's list: two columns of the brief's own names
 * and figures, read downward with a middle dot between them, falling slowly
 * and faint. They run in the list's two margins, the left gutter before the
 * designators and the right margin before the rail, never under a text
 * column: no headline or figure sits on moving glyphs (polish round). Words, not a font sample: no column carries one word twice
 * running (round 3's "A I A I A").
 *
 * streamColumns is pure and deterministic. createStream builds the columns
 * once per distinct word list; each column is its own composited layer, moved
 * by transform alone (panel.css), still under reduced motion.
 *
 * Words are untrusted (repo names, titles): they are cleaned to a small set of
 * characters and set with textContent only.
 */

const DOT = '·';
/** A cleaned word is at most this long, so a column never holds one word for long. */
const WORD_MAX = 14;
/** What an empty brief streams: figures with nothing behind them. */
const FILLER = ['00', '0.0', '#0', '0%', '00.00'];

/** A word as the stream shows it: no whitespace, only `A-Za-z0-9#.%-`, cut to 14 characters. */
export function cleanWord(word: string): string {
  return word.replace(/[^A-Za-z0-9#.%-]/g, '').slice(0, WORD_MAX);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * `columns` columns of at most `rows` characters, each a run of the cleaned
 * words with a dot after each, cut at a word. Each column walks the distinct
 * words from its own start with its own stride, the stride prime to the count,
 * so no word follows itself and neighbouring columns differ.
 */
export function streamColumns(words: string[], columns: number, rows: number): string[] {
  const seen = new Set<string>();
  for (const w of words) {
    const c = cleanWord(w);
    if (c) seen.add(c);
  }
  let pool = [...seen];
  if (pool.length < 2) pool = [...pool, ...FILLER.filter((f) => !seen.has(f))];
  const n = pool.length;
  const strides: number[] = [];
  for (let s = 1; s < n; s++) if (gcd(s, n) === 1) strides.push(s);

  const out: string[] = [];
  for (let i = 0; i < columns; i++) {
    const start = i % n;
    const stride = strides[Math.floor(i / n) % strides.length];
    let col = '';
    for (let k = 0; ; k++) {
      const w = pool[(start + k * stride) % n] + DOT;
      if (col.length + w.length > rows) break;
      col += w;
    }
    // A column too short for even one word holds the start of one.
    out.push(col || pool[start].slice(0, Math.max(1, rows - 1)) + DOT);
  }
  return out;
}

/**
 * The margins a column runs in: its side of the panel and its offset in px from that edge. The left gutter is
 * the list's 30px padding before the designators; the right lane stands between the keys' reticles and the rail.
 */
export const LANES: ReadonlyArray<{ side: 'left' | 'right'; offset: number }> = [
  { side: 'left', offset: 7 },
  { side: 'right', offset: 15 },
];

/** Where a column stands (its lane), how long it takes to fall, its head start, and its opacity (always under 0.2). */
export function columnLook(i: number): { side: 'left' | 'right'; offset: number; seconds: number; delay: number; opacity: number } {
  const lane = LANES[i % LANES.length];
  return {
    side: lane.side,
    offset: lane.offset,
    seconds: 44 + ((i * 17) % 29),
    delay: -((i * 11) % 30),
    opacity: i % 2 ? 0.15 : 0.17,
  };
}

/** The columns a stream shows (one a lane), and how many characters each runs to: enough for a tall panel. */
const COLUMNS = LANES.length;
const ROWS = 96;

/**
 * The stream, prepended to `host` (behind everything in it), filled from the
 * brief's words. A fill with the same words as the last does nothing.
 */
export function createStream(host: HTMLElement): { root: HTMLElement; fill(words: string[]): void } {
  const box = document.createElement('div');
  box.className = 'os-stream';
  box.setAttribute('aria-hidden', 'true');
  host.prepend(box);
  let key: string | null = null;
  return {
    root: box,
    fill(words) {
      const k = words.join('\u0000');
      if (k === key) return;
      key = k;
      const cols = streamColumns(words, COLUMNS, ROWS).map((text, i) => {
        const col = document.createElement('div');
        col.className = 'os-stream-col';
        // Twice over, so the fall loops without a seam.
        col.textContent = text + text;
        const look = columnLook(i);
        col.style.setProperty(look.side === 'left' ? '--os-l' : '--os-r', `${look.offset}px`);
        col.style.setProperty('--os-t', `${look.seconds}s`);
        col.style.setProperty('--os-d', `${look.delay}s`);
        col.style.setProperty('--os-o', String(look.opacity));
        return col;
      });
      box.replaceChildren(...cols);
    },
  };
}
