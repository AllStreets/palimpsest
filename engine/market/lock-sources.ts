/**
 * The GitHub sources a repo's own lockfiles name, read from the run's clone
 * before the install stage opens its egress. A dependency fetched over HTTPS
 * from GitHub adds exactly the host it needs: codeload.github.com for a
 * tarball, github.com for a git clone over HTTPS, both for a github.com
 * archive (it redirects to codeload). A dependency fetched over SSH or the
 * bare git protocol is refused by name, since the sandbox reaches neither,
 * so the install fails with that reason instead of a bare git error. No
 * other host is ever added: one the lockfile names that is not GitHub stays
 * refused by the proxy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The lockfiles (and pinned requirement files) read, in the order they are reported. */
export const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'requirements.txt', 'pyproject.toml'];

export interface RefusedSource {
  /** The dependency's name as the lockfile gives it. */
  name: string;
  /** The URL it resolves to. */
  url: string;
  /** The lockfile that names it. */
  file: string;
  reason: string;
}

export interface LockSources {
  /** The GitHub HTTPS hosts the lockfiles need beyond the registries, in order, without repeats. */
  hosts: string[];
  refused: RefusedSource[];
}

/** A URL in lockfile text: a scheme URL, or an scp-style `user@host:path` whose host has a letter and a dot. */
const URL_RE = /(?:git\+)?(?:https?|ssh|git):\/\/[^\s"'},;]+|\b[\w.-]+@[\w-]*[A-Za-z][\w-]*(?:\.[\w-]+)+:[\w.-]+\/[\w./-]+/g;

type Verdict = { hosts: string[] } | { refuse: string };

/** What fetching `raw` needs: GitHub HTTPS hosts, nothing (another host, left to the proxy), or a refusal. */
export function classify(raw: string): Verdict {
  const url = raw.trim();
  if (/^(git\+)?ssh:\/\//i.test(url) || (!/^[a-z+]+:\/\//i.test(url) && /^[\w.-]+@[^:/]+:/.test(url))) {
    return { refuse: 'fetches over SSH' };
  }
  if (/^git:\/\//i.test(url)) return { refuse: 'fetches over the git protocol' };
  let u: URL;
  try {
    u = new URL(url.replace(/^git\+/i, ''));
  } catch {
    return { hosts: [] };
  }
  if (u.protocol !== 'https:') return { hosts: [] };
  const host = u.hostname.toLowerCase();
  if (host === 'codeload.github.com') return { hosts: ['codeload.github.com'] };
  if (host === 'github.com') {
    const archive = !/^git\+/i.test(url) && /^\/[^/]+\/[^/]+\/(archive|tarball|zipball)\//.test(u.pathname);
    return { hosts: archive ? ['github.com', 'codeload.github.com'] : ['github.com'] };
  }
  return { hosts: [] };
}

/** The HTTPS tarball a GitHub SSH or git URL pinned to a full sha could use instead, or null. */
export function httpsTarball(raw: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#@]|\?rev=)([0-9a-f]{40})\b/.exec(raw);
  return m ? `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${m[3]}` : null;
}

/** The repo name in a URL, for a dependency the lockfile does not name. */
function nameFromUrl(url: string): string {
  const path = url.replace(/[#?].*$/, '').replace(/@[0-9a-f]{7,40}$/, '');
  return path.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, '') ?? url;
}

/** A package name out of a `name@spec` key (scoped names keep their leading `@`). */
function nameFromKey(key: string): string {
  const k = key.trim().replace(/^["']|["']$/g, '').replace(/^\//, '').split(/,\s*/)[0].replace(/^["']|["']$/g, '');
  const at = k.indexOf('@', 1);
  return at > 0 ? k.slice(0, at) : k;
}

function read(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

/** `[name, url]` pairs from an npm lockfile's `packages` (v2, v3) and `dependencies` (v1). */
function npmPairs(text: string): Array<[string, string]> {
  let lock: { packages?: Record<string, Record<string, unknown>>; dependencies?: Record<string, Record<string, unknown>> };
  try {
    lock = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path || !entry || typeof entry.resolved !== 'string') continue;
    const name = typeof entry.name === 'string' ? entry.name : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push([name, entry.resolved]);
  }
  const walk = (deps: Record<string, Record<string, unknown>> | undefined) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      for (const key of ['resolved', 'version']) {
        const v = entry[key];
        if (typeof v === 'string' && /:\/\/|@[^/]+:/.test(v)) out.push([name, v]);
      }
      walk(entry.dependencies as Record<string, Record<string, unknown>> | undefined);
    }
  };
  if (!lock?.packages) walk(lock?.dependencies);
  return out;
}

/** `[name, url]` pairs from a line-based lockfile, the name taken from the entry each line belongs to. */
function linePairs(file: string, text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let name: string | null = null;
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) && file !== 'requirements.txt') continue;
    if (file === 'yarn.lock' && /^\S.*:\s*$/.test(line)) name = nameFromKey(line.replace(/:\s*$/, ''));
    if (file === 'pnpm-lock.yaml' && /^ {2}\S.*:\s*$/.test(line)) name = nameFromKey(line.replace(/:\s*$/, ''));
    if (file === 'Cargo.lock') {
      if (/^\[\[package\]\]/.test(line)) name = null;
      const n = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (n) name = n[1];
      const s = /^source\s*=\s*"([^"]+)"/.exec(line);
      // Only git sources: a registry+ source is the crates index, reached through the registry hosts.
      if (s && /^git\+/.test(s[1]) && name) out.push([name, s[1]]);
      continue;
    }
    let lineName = name;
    if (file === 'requirements.txt' || file === 'pyproject.toml') {
      if (/^\s*#/.test(line)) continue;
      const egg = /[#&]egg=([\w.-]+)/.exec(line);
      const at = /^\s*["']?([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*@\s*/.exec(line);
      lineName = egg?.[1] ?? at?.[1] ?? null;
    }
    for (const m of line.matchAll(URL_RE)) out.push([lineName ?? nameFromUrl(m[0]), m[0]]);
  }
  return out;
}

/** The GitHub hosts the lockfiles at the root of `dir` need, and the dependencies no run may fetch. */
export function lockSources(dir: string): LockSources {
  const hosts = new Set<string>();
  const refused: RefusedSource[] = [];
  const seen = new Set<string>();
  for (const file of LOCK_FILES) {
    const text = read(dir, file);
    if (text === null) continue;
    const pairs = file === 'package-lock.json' || file === 'npm-shrinkwrap.json' ? npmPairs(text) : linePairs(file, text);
    for (const [name, url] of pairs) {
      const v = classify(url);
      if ('hosts' in v) {
        for (const h of v.hosts) hosts.add(h);
        continue;
      }
      const key = `${file}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refused.push({ name, url, file, reason: v.refuse });
    }
  }
  return { hosts: [...hosts], refused };
}

/** One plain sentence per refused dependency, with the HTTPS form to pin instead when there is one. */
export function refusalText(refused: RefusedSource[]): string {
  return refused
    .map((r) => {
      const fix = httpsTarball(r.url);
      return `${r.name} in ${r.file} resolves to ${r.url}, which ${r.reason}, and a run's install reaches only HTTPS hosts; pin it over HTTPS${fix ? `, as ${fix}` : ''}`;
    })
    .join('. ');
}
