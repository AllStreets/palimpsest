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

/** What the towers' table depends on: the variants and how they become materials, the board, the scans, the light. */
export function towerInputs(): string {
  return fingerprint([
    read('app/src/city/tower/variants.ts').replace(/^import .*rendered.*$/m, ''),
    read('app/src/city/tower/look.ts'),
    read('app/src/city/tower/swatches.ts'),
    read('app/src/city/materials.ts'),
    light(),
  ]);
}

/**
 * What the ambient table depends on: the tones and sections (the section and
 * tone tables of lots.ts), the facade programs, the
 * board, the scans and the light. The rest of lots.ts (layout, the plaza-edge
 * rule) chooses where tones go, not how they render, so it is left out.
 */
export function ambientInputs(): string {
  const lots = read('app/src/city/lots.ts');
  const slice = (start: string, end: string): string => {
    const from = lots.indexOf(start);
    const to = lots.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`lots.ts: ${start} moved; update tools/measure-inputs.ts`);
    return lots.slice(from, to);
  };
  return fingerprint([slice('export const SECTIONS', '/** A section'), slice('export const TONES', 'const TONE_BY_ID'), read('app/src/city/facade.ts'), read('app/src/city/ambient-swatches.ts'), read('app/src/city/materials.ts'), light()]);
}
