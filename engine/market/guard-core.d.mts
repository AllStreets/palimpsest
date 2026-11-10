/** Types for guard-core.mjs (plain JS so the hook runs under plain node). */

export type FileTool = 'Read' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Glob' | 'Grep';

export declare const FORBIDDEN_REASONS: Readonly<{
  push: string;
  remote: string;
  config: string;
  rewrite: string;
  resetRemote: string;
  rebaseRemote: string;
  branchDelete: string;
  tagDelete: string;
  gh: string;
  rmOutside: string;
  privileged: string;
  pipeShell: string;
  gitDir: string;
  credentials: string;
  unreadable: string;
  pathOutside: string;
  pathGit: string;
  pathSymlink: string;
  pathHardlink: string;
  pathBad: string;
  pathUnresolved: string;
}>;

/** The reason `command` must not run in a city run, or null. */
export declare function forbidden(command: string, dir: string, dataHome: string): string | null;

/** The reason a file tool may not touch `path` inside `dir`, or null (ruling 29). */
export declare function pathAllowed(tool: FileTool, path: string, dir: string): string | null;

/** The reason a glob pattern may not be used, or null. */
export declare function patternAllowed(pattern: string): string | null;
