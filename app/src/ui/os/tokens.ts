/**
 * The screens' design tokens: colour, the panel's ground, depth, glow and
 * motion. tokens.css declares the same values as `--os-*` custom properties on
 * :root, and a test holds the two equal (`cssTokens`). The colours are held to
 * 4.5:1 by test over the thinnest ground on the city's brightest pixel.
 */
import type { Rgb } from '../contrast.js';

export type ColourToken = 'ground' | 'ink' | 'ink2' | 'dim' | 'amber' | 'amberHi' | 'red' | 'ice' | 'ok' | 'warn' | 'fail' | 'benched';

/** Every colour of the screens, `#rrggbb`. Red is the lock's and the grant's alone. */
export const COLOUR: Readonly<Record<ColourToken, string>> = Object.freeze({
  ground: '#090604',
  ink: '#f5e9d9',
  ink2: '#c9b49c',
  dim: '#a48f78',
  amber: '#ffb547',
  amberHi: '#ffd391',
  red: '#ff5532',
  ice: '#9fe3fb',
  ok: '#9ee6b4',
  warn: '#ffc861',
  fail: '#ff7a5e',
  benched: '#a9a3b8',
});

export type Tone = 'ok' | 'warn' | 'fail' | 'benched' | 'quiet';

/** The ink each tone is set in. */
export const TONE_INK: Record<Tone, ColourToken> = { ok: 'ok', warn: 'warn', fail: 'fail', benched: 'benched', quiet: 'dim' };

/**
 * The panel's warm black, and the thinnest alpha it may have under any text.
 * The prototype thinned it to 0.8 at its far edge, where dim fell to 3.8:1 over
 * white; 0.86 is the least that holds every ink, red included, at 4.5:1.
 */
export const GROUND: { rgb: Rgb; textMinAlpha: number } = { rgb: [9, 6, 4], textMinAlpha: 0.86 };

/** The dark backplate behind a pin's or the lock's tag, standing on the city itself. */
export const PLATE: { rgb: Rgb; alpha: number } = { rgb: [9, 6, 4], alpha: 0.9 };

export type Depth = 'near' | 'mid' | 'far';

/**
 * The three panes' depth: how far each drifts with the pointer at the edge of
 * its host (near with it, far against it, mid still), and the shadow it casts.
 */
export const DEPTH: Record<Depth, { parallax: { x: number; y: number }; shadow: string }> = {
  near: { parallax: { x: 5, y: 3.5 }, shadow: '16px 14px 26px -12px rgba(0, 0, 0, 0.85), 0 30px 80px rgba(0, 0, 0, 0.55)' },
  mid: { parallax: { x: 0, y: 0 }, shadow: '0 12px 28px -14px rgba(0, 0, 0, 0.9)' },
  far: { parallax: { x: -7, y: -5 }, shadow: '0 6px 16px -10px rgba(0, 0, 0, 0.7)' },
};

/** The light each weight of key gives off. Static box-shadows, never animated. */
export const GLOW: Record<'look' | 'spend' | 'grant', string> = {
  look: '0 0 10px rgba(159, 227, 251, 0.35)',
  spend: 'inset 0 0 0 1px rgba(255, 181, 71, 0.5), 0 0 16px rgba(255, 181, 71, 0.16)',
  grant: '0 0 0 1px rgba(255, 120, 80, 0.9), 0 0 26px rgba(255, 85, 50, 0.55), 0 0 70px rgba(255, 85, 50, 0.22)',
};

/** Durations in ms; type-in runs at `typeCps` characters a second and never outlasts `typeMaxMs`. */
export const MOTION: { fast: number; base: number; slow: number; typeCps: number; typeMaxMs: number; scanMs: number; ease: string } = {
  fast: 140,
  base: 240,
  slow: 450,
  typeCps: 90,
  typeMaxMs: 600,
  scanMs: 900,
  ease: 'cubic-bezier(0.2, 0.75, 0.15, 1)',
};

/** The two faces, with their fallbacks. */
const DISPLAY = "'Big Shoulders', 'Avenir Next Condensed', system-ui, sans-serif";
const MONO = "'Azeret Mono', ui-monospace, Menlo, monospace";

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
/** Folds -0 into 0, so a pane at rest reads as { 0, 0 }. */
const zero = (v: number): number => v + 0;

/**
 * How far a pane at `depth` drifts for a pointer over `rect`: the pointer's
 * offset from the centre, as a fraction of the half-size clamped to -1..1,
 * times the depth's parallax. A pointer past the edge drifts no further.
 */
export function parallaxOffset(pointer: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }, depth: Depth): { x: number; y: number } {
  const p = DEPTH[depth].parallax;
  const nx = rect.width > 0 ? clamp1((pointer.x - (rect.left + rect.width / 2)) / (rect.width / 2)) : 0;
  const ny = rect.height > 0 ? clamp1((pointer.y - (rect.top + rect.height / 2)) / (rect.height / 2)) : 0;
  return { x: zero(nx * p.x), y: zero(ny * p.y) };
}

/** `amberHi` to `amber-hi`. */
const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const rgbList = (h: string): string => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');

/** Every custom property tokens.css declares on :root, by name, with its value. */
export function cssTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(COLOUR)) out[`--os-${kebab(k)}`] = v;
  for (const k of ['ground', 'amber', 'red', 'ice'] as const) out[`--os-${k}-rgb`] = rgbList(COLOUR[k]);
  out['--os-ground-alpha'] = String(GROUND.textMinAlpha);
  out['--os-plate-alpha'] = String(PLATE.alpha);
  out['--os-display'] = DISPLAY;
  out['--os-mono'] = MONO;
  for (const [k, v] of Object.entries(DEPTH)) out[`--os-shadow-${k}`] = v.shadow;
  for (const [k, v] of Object.entries(GLOW)) out[`--os-glow-${k}`] = v;
  out['--os-fast'] = `${MOTION.fast}ms`;
  out['--os-base'] = `${MOTION.base}ms`;
  out['--os-slow'] = `${MOTION.slow}ms`;
  out['--os-scan'] = `${MOTION.scanMs}ms`;
  out['--os-ease'] = MOTION.ease;
  return out;
}
