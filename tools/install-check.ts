/**
 * No local dependencies at launch (Phase 5 ruling 22):
 *
 *   npm run install:check
 *
 * Fails when any dependency in package.json, or any `resolved` or `version`
 * in package-lock.json, begins with `file:` or `git+file:`, naming each: a
 * stranger's clone cannot install from a folder on this Mac. It fails today
 * by design (the Beagle pin), so it is not part of npm test until Task 33
 * moves the pin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL = /^(git\+)?file:/;
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each local dependency in a package.json and its lock, one line each. */
export function installCheck(pkg: object, lock: object): string[] {
  const out: string[] = [];
  const p = pkg as Obj;
  for (const field of FIELDS) {
    const deps = p[field];
    if (!isObj(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) if (typeof spec === 'string' && LOCAL.test(spec)) out.push(`package.json ${field} ${name}: ${spec}`);
  }
  const l = lock as Obj;
  // lockfileVersion 2 and 3: a flat map of install paths; the root entry ('') is the package itself.
  if (isObj(l.packages)) {
    for (const [path, entry] of Object.entries(l.packages)) {
      if (path === '' || !isObj(entry)) continue;
      for (const key of ['resolved', 'version'] as const) {
        const v = entry[key];
        if (typeof v === 'string' && LOCAL.test(v)) out.push(`package-lock.json ${path} ${key}: ${v}`);
      }
      // npm records a file: dependency as a link to a folder, without the prefix: `resolved: "../x", link: true`.
      const r = entry.resolved;
      if (entry.link === true && typeof r === 'string' && !LOCAL.test(r) && !/^(node_modules\/|https?:)/.test(r)) out.push(`package-lock.json ${path} link: ${r}`);
    }
  }
  // lockfileVersion 1 (and 2's mirror of it): nested dependencies.
  else if (isObj(l.dependencies)) {
    const walk = (deps: Obj, trail: string[]): void => {
      for (const [name, entry] of Object.entries(deps)) {
        if (!isObj(entry)) continue;
        const at = [...trail, name];
        for (const key of ['resolved', 'version'] as const) {
          const v = entry[key];
          if (typeof v === 'string' && LOCAL.test(v)) out.push(`package-lock.json ${at.join(' > ')} ${key}: ${v}`);
        }
        if (isObj(entry.dependencies)) walk(entry.dependencies, at);
      }
    };
    walk(l.dependencies, []);
  }
  return out;
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (f: string): object => JSON.parse(readFileSync(join(root, f), 'utf8')) as object;
  const found = installCheck(read('package.json'), read('package-lock.json'));
  if (found.length === 0) {
    console.log('No local dependencies: a clone installs from the registry alone.');
    return;
  }
  console.error(`${found.length} local ${found.length === 1 ? 'dependency' : 'dependencies'} a stranger's clone cannot install:`);
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
