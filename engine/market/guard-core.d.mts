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
  reservedPort: string;
  unreadable: string;
  pathOutside: string;
  pathGit: string;
  pathSymlink: string;
  pathHardlink: string;
  pathBad: string;
  pathUnresolved: string;
}>;

/** The engine's port and Ollama's, always refused next to a loopback host. */
export declare const RESERVED_PORTS: readonly number[];

/** The reason `command` must not run in a city run, or null. `ports` adds loopback ports to refuse (the engine's own, live runs'). */
export declare function forbidden(command: string, dir: string, dataHome: string, ports?: number[]): string | null;

/** The reason a file tool may not touch `path` inside `dir`, or null (ruling 29). */
export declare function pathAllowed(tool: FileTool, path: string, dir: string): string | null;

/** The reason a glob pattern may not be used, or null. */
export declare function patternAllowed(pattern: string): string | null;
