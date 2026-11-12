import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasFigures, registerFigures } from '../app/src/city/figures.js';

/** Registers the Blender figures from app/public/kits/figures.glb, as the app's loadFigures does in the browser. */
export function useFigures(): void {
  if (hasFigures()) return;
  const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'public', 'kits', 'figures.glb'));
  registerFigures(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
}

useFigures();
