/**
 * The ui-test's last word. A partial mode (UI_ONLY=<part>, UI_FORCE_DROP=1)
 * runs a slice of the checks for a quality round: it never prints "ui-test
 * passed" and exits with PARTIAL_EXIT, so no script or reader takes it for
 * a full pass. Failures exit 1 in any mode.
 */
export const PARTIAL_EXIT = 3;

/** The partial mode the environment asks for, as it reads, or null for a full run. */
export function partialMode(env: Record<string, string | undefined>): string | null {
  if (env.UI_ONLY) return `UI_ONLY=${env.UI_ONLY}`;
  if (env.UI_FORCE_DROP === '1') return 'UI_FORCE_DROP=1';
  return null;
}

export function verdict(failures: ReadonlyArray<string>, partial: string | null): { code: number; line: string } {
  const note = partial ? `PARTIAL run (${partial}): not a full pass` : null;
  if (failures.length > 0) return { code: 1, line: `${failures.length} check(s) failed${note ? ` (${note})` : ''}` };
  if (note) return { code: PARTIAL_EXIT, line: note };
  return { code: 0, line: 'ui-test passed' };
}
