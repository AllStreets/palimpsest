/**
 * The guard (Task 8), typed for the engine. The rules live in
 * guard-core.mjs, plain JS shared with the PreToolUse hook and the file
 * tool, so the hook needs no TypeScript loader.
 */
export { FORBIDDEN_REASONS, forbidden, pathAllowed, patternAllowed, type FileTool } from './guard-core.mjs';
