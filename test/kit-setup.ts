import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasKit, registerKits } from '../app/src/city/kits.js';

/** Registers the Blender kits from app/public/kits/kits.glb, as the app's loadKits does in the browser. */
export function useKits(): void {
  if (hasKit('course_a.hi')) return;
  const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'public', 'kits', 'kits.glb'));
  registerKits(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
}

useKits();
