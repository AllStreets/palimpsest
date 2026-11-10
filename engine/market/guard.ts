/**
 * The guard (Task 8), typed for the engine. The rules live in
 * guard-core.mjs, plain JS shared with the PreToolUse hook and the file
 * tool, so the hook needs no TypeScript loader.
 */
export { FORBIDDEN_REASONS, forbidden, pathAllowed, patternAllowed, type FileTool } from './guard-core.mjs';

/**
 * Tools the claude CLI must never have in a city run, for `--disallowedTools`
 * (Task 9). A second layer beside the hook, which already refuses every tool
 * but the file tools and the run tool: should the hook fail to start, these
 * are still gone.
 */
export const CLI_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'SlashCommand',
  'Skill',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
];

/**
 * `permissions.deny` rules for the run's settings.json (Task 9): every
 * disallowed tool plus his credentials, Claude configuration and any
 * repository's .git, so a file tool call the hook missed still meets a deny.
 */
export const CLI_PERMISSIONS_DENY: readonly string[] = [
  ...CLI_DISALLOWED_TOOLS,
  ...['Read', 'Edit', 'Write'].flatMap((t) => [
    `${t}(~/.claude/**)`,
    `${t}(~/.claude.json)`,
    `${t}(~/.config/gh/**)`,
    `${t}(~/.ssh/**)`,
    `${t}(~/.aws/**)`,
    `${t}(~/.gnupg/**)`,
    `${t}(~/.netrc)`,
    `${t}(~/.npmrc)`,
    `${t}(~/.gitconfig)`,
    `${t}(~/.git-credentials)`,
    `${t}(~/Library/Keychains/**)`,
    `${t}(//**/.git/**)`,
  ]),
];
