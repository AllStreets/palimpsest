/**
 * The port the ui-test's own engine binds and every page and fetch of the
 * harness calls: UI_PORT when set, so ui-tests in different worktrees stop
 * colliding, 4779 otherwise. The real engine's 4770 and the dev server's
 * 4771 are refused, so a test never answers in place of his engine.
 */
export const UI_PORT_DEFAULT = 4779;
const RESERVED = new Set([4770, 4771]);

export function uiPort(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  if (text === '') return UI_PORT_DEFAULT;
  if (!/^\d+$/.test(text)) throw new Error(`UI_PORT must be a port number, not ${JSON.stringify(raw)}`);
  const port = Number(text);
  if (port < 1024 || port > 65535) throw new Error(`UI_PORT must be between 1024 and 65535, not ${port}`);
  if (RESERVED.has(port)) throw new Error(`UI_PORT ${port} is the real engine's or the dev server's port; pick another`);
  return port;
}
