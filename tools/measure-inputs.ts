/**
 * Fingerprints of what the measured colour tables depend on. The tables
 * (app/src/city/tower/rendered.ts and app/src/city/ambient-rendered.ts) are
 * screenshots of the scene turned into numbers: they go stale, silently,
 * when a palette, a material, the grade or the light changes. The capture
 * tool stamps each table with the fingerprint of its inputs when it writes
 * it, and test/measured.test.ts fails when today's inputs fingerprint
 * differently, so a change to the look asks for a deliberate re-measure.
 *
 * Node only (reads sources from disk).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TONES } from '../app/src/city/lots.js';
import { SCAN_STATS, VARIANTS } from '../app/src/city/tower/variants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * The scene's light and grade: the lines of scene.ts that set tone mapping,
 * exposure, fog, environment, the sun and the sky fill (the rest of scene.ts
 * is camera and picking, which no measurement sees), and the whole of the
 * sky and post-processing modules.
 */
function light(): string {
  const scene = read('app/src/city/scene.ts')
    .split('\n')
    .filter((l) => /toneMapping|Exposure|FogExp2|environment|DirectionalLight|HemisphereLight|shadow\.(bias|normalBias)/.test(l))
    .join('\n');
  return [scene, read('app/src/city/sky.ts'), read('app/src/city/post.ts')].join('\n');
}

function fingerprint(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p.replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex').slice(0, 16);
}

/**
 * Each row's stamp (Task 15): a hash of what that row was measured from, the
 * inputs every row shares (`shared`) and the row's own material parameters.
 * The stamps are written beside the table as one line, `rows <id>=<hash>;...`,
 * so a change to one look's parameters makes that row stale, by name, and a
 * change to what every row shares makes them all stale.
 */
function stamp(shared: string, own: unknown): string {
  return fingerprint([shared, JSON.stringify(own)]).slice(0, 10);
}
function rowsLine(rows: Record<string, string>): string {
  return `rows ${Object.entries(rows)
    .map(([id, h]) => `${id}=${h}`)
    .join(';')}`;
}
/** The stamps a table's inputs line holds, by row id (empty for a line written before stamps were per row). */
export function readStamps(line: string): Record<string, string> {
  if (!line.startsWith('rows ')) return {};
  const out: Record<string, string> = {};
  for (const pair of line.slice(5).split(';')) {
    const at = pair.lastIndexOf('=');
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}
/** The rows of a table that are stale: measured from other inputs than today's, or not stamped at all. */
export function staleRows(stored: string, now: string, ids: Iterable<string>): string[] {
  const was = readStamps(stored);
  const is = readStamps(now);
  return [...ids].filter((id) => !was[id] || was[id] !== is[id]);
}

/** What every tower row depends on: how variants become materials, the board, the scans and their stats, the light. */
function towerShared(): string {
  return fingerprint([read('app/src/city/tower/look.ts'), read('app/src/city/tower/swatches.ts'), read('app/src/city/materials.ts'), JSON.stringify(SCAN_STATS), light()]);
}

/** Each tower variant's stamp: the shared inputs and the variant's own parameters (its finishes, glass and family). */
export function towerStamps(): Record<string, string> {
  const shared = towerShared();
  const out: Record<string, string> = {};
  for (const list of Object.values(VARIANTS)) for (const v of list) out[v.id] = stamp(shared, v);
  return out;
}

/** What the towers' table depends on, row by row (the line the capture tool writes beside the table). */
export function towerInputs(): string {
  return rowsLine(towerStamps());
}

/**
 * What the ambient table depends on: the sections (the section table of
 * lots.ts), the facade programs (and the rooms behind their windows,
 * rooms.ts, whose GLSL the facade program pastes in), the board, the scans
 * and the light, shared by every row; and each tone's own parameters. The
 * rest of lots.ts (layout, the plaza-edge rule) chooses where tones go, not
 * how they render, so it is left out.
 */
export function ambientStamps(): Record<string, string> {
  const lots = read('app/src/city/lots.ts');
  const slice = (start: string, end: string): string => {
    const from = lots.indexOf(start);
    const to = lots.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`lots.ts: ${start} moved; update tools/measure-inputs.ts`);
    return lots.slice(from, to);
  };
  const shared = fingerprint([slice('export const SECTIONS', '/** A section'), read('app/src/city/facade.ts'), read('app/src/city/rooms.ts'), read('app/src/city/ambient-swatches.ts'), read('app/src/city/materials.ts'), light()]);
  const out: Record<string, string> = {};
  for (const list of Object.values(TONES)) for (const t of list) out[t.id] = stamp(shared, t);
  return out;
}

export function ambientInputs(): string {
  return rowsLine(ambientStamps());
}
