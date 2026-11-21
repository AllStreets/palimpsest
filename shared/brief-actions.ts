import type { BriefAction } from './types.js';

/**
 * The Brief's looks: the actions recorded with look() (Ask why, the diff,
 * Fly there, Open PR). A look is not a decision, so it never covers one the
 * row already holds (engine/brief.ts), and the Brief records it without
 * waiting on the answer (app/src/ui/brief.ts). One constant for both, so
 * they never drift; held to main's by test/brief-actions.test.ts.
 */
export const LOOKS: readonly BriefAction[] = ['why', 'diff', 'fly', 'open-pr'];
