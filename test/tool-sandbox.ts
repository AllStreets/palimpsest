/**
 * Tests that cannot run inside the tool sandbox. The inspection runs a
 * repo's suite under the tool profile with IN_TOOL_SANDBOX_ENV set
 * (sandbox.ts childEnv, stage `checks`), and there macOS refuses a nested
 * sandbox-exec and the profile refuses a setuid /bin/ps (and real network,
 * which no test here needs). A test that needs one skips itself there, with
 * a reason from NEEDS in words
 * the test check reads back (checks.ts parseSandboxSkips) and names in its
 * detail. Everywhere else (npm test on his Mac, CI) it runs as before.
 */
import { SANDBOX_SKIP } from '../engine/guild/checks.js';
import { IN_TOOL_SANDBOX_ENV } from '../engine/market/sandbox.js';

/** True when this suite runs as an inspection's test check, inside the tool sandbox. */
export const IN_TOOL_SANDBOX = process.env[IN_TOOL_SANDBOX_ENV] === '1';

/** The `skip` option of a test that cannot run in the tool sandbox: the reason there, false elsewhere. */
export function outsideToolSandbox(why: string): string | false {
  return IN_TOOL_SANDBOX ? `${SANDBOX_SKIP}${why}` : false;
}

/** The reasons, said the same way in every file. */
export const NEEDS = {
  nestedSandbox: 'needs a nested sandbox-exec, which macOS refuses inside a sandbox',
  ps: 'reads a process with the setuid /bin/ps, which the tool profile refuses to execute',
} as const;
