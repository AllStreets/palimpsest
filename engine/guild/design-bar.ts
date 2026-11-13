/**
 * His design bar and the vision judge that holds UI to it, apart from the
 * design check itself so the Understudy reader can use them without
 * importing the check (which reads Understudy).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelRef } from '../../shared/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The vision judge (Task 10's Ollama path); it sees the screenshots. */
export const VISION_JUDGE: ModelRef = 'ollama:qwen2.5vl:7b*';

/** His design bar, in prose, for the judge. */
export function designBar(): string {
  return readFileSync(join(HERE, 'design-bar.md'), 'utf8');
}
