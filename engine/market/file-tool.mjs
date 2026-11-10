/**
 * The local tool loop's file tools (ruling 29): read, write, edit, list and
 * search, run only by execFileTool() under the tool profile, never in the
 * engine.
 *
 *   node file-tool.mjs <dir> <op> <json args | ->
 *
 * With `-` the JSON arguments are read from stdin (a write's content can be
 * larger than an argv). Every path goes through pathAllowed() first; every
 * file is opened with O_NOFOLLOW (writes with O_NOFOLLOW | O_CREAT, never
 * truncating before the check), symlinks found while listing are shown and
 * never followed, and searching skips them. Prints one JSON object:
 * `{ ok: true, ... }`, `{ ok: false, refused }` (exit 3) or
 * `{ ok: false, error }` (exit 1; exit 2 for bad arguments).
 */
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { pathAllowed, patternAllowed } from './guard-core.mjs';

export const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 2000;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE = 1024 * 1024;
const MAX_SEARCH_FILES = 20_000;

const { O_RDONLY, O_RDWR, O_WRONLY, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = constants;

class Refused extends Error {}
class BadArgs extends Error {}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(code));
}

function str(args, key, required = true) {
  const v = args[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') throw new BadArgs(`${key} must be a string`);
  return v;
}

function check(tool, path, dir) {
  const r = pathAllowed(tool, path, dir);
  if (r) throw new Refused(r);
  return resolve(dir, path);
}

/** Opens a regular file without following a symlink, and refuses anything else (a FIFO, a device, a hard-linked file). */
function openFile(abs, flags) {
  const fd = openSync(abs, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new Refused('not a regular file');
  }
  if (st.nlink > 1) {
    closeSync(fd);
    throw new Refused('The file has more than one hard link, so it may be a file outside the repository.');
  }
  return { fd, size: st.size };
}

function readAll(fd, size, cap) {
  const n = Math.min(size, cap);
  const buf = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    const got = readSync(fd, buf, off, n - off, off);
    if (got === 0) break;
    off += got;
  }
  return buf.subarray(0, off);
}

function writeAll(fd, data) {
  const buf = Buffer.from(data, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, off);
}

/** Creates the missing parents of `abs` inside `dir` one by one, refusing any symlink on the way. */
function makeParents(abs, dir) {
  const rel = relative(dir, abs).split('/').slice(0, -1);
  let cur = dir;
  for (const part of rel) {
    cur = join(cur, part);
    let st = null;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Refused('The path is or passes through a symlink, which file tools never follow.');
  }
}

function opRead(dir, args) {
  const abs = check('Read', str(args, 'path'), dir);
  const { fd, size } = openFile(abs, O_RDONLY);
  try {
    const buf = readAll(fd, size, MAX_READ_BYTES);
    return { content: buf.toString('utf8'), bytes: size, truncated: size > MAX_READ_BYTES };
  } finally {
    closeSync(fd);
  }
}

function opWrite(dir, args) {
  const path = str(args, 'path');
  const content = str(args, 'content');
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new BadArgs('content too large');
  const abs = check('Write', path, dir);
  makeParents(abs, dir);
  check('Write', path, dir);
  const { fd } = openFile(abs, O_WRONLY | O_CREAT);
  try {
    ftruncateSync(fd, 0);
    writeAll(fd, content);
    return { written: Buffer.byteLength(content) };
  } finally {
    closeSync(fd);
  }
}

function opEdit(dir, args) {
  const abs = check('Edit', str(args, 'path'), dir);
  const old = str(args, 'old');
  const next = str(args, 'new');
  const all = args.all === true;
  if (old === '') throw new BadArgs('old must not be empty');
  const { fd, size } = openFile(abs, O_RDWR);
  try {
    if (size > MAX_WRITE_BYTES) throw new BadArgs('file too large to edit');
    const text = readAll(fd, size, MAX_WRITE_BYTES).toString('utf8');
    const count = text.split(old).length - 1;
    if (count === 0) throw new BadArgs('old text not found');
    if (count > 1 && !all) throw new BadArgs(`old text found ${count} times; pass all or a longer old text`);
    const updated = all ? text.split(old).join(next) : text.replace(old, () => next);
    ftruncateSync(fd, 0);
    writeAll(fd, updated);
    return { replaced: all ? count : 1 };
  } finally {
    closeSync(fd);
  }
}

function typeOf(d) {
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isDirectory()) return 'dir';
  if (d.isFile()) return 'file';
  return 'other';
}

function opList(dir, args) {
  const path = str(args, 'path', false) ?? '.';
  const abs = check('Glob', path, dir);
  const recursive = args.recursive === true;
  const entries = [];
  let truncated = false;
  const walk = (at) => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      if (entries.length >= MAX_LIST) {
        truncated = true;
        return;
      }
      const full = join(at, d.name);
      if (d.name.toLowerCase() === '.git') continue;
      const type = typeOf(d);
      entries.push({ path: relative(dir, full), type: type === 'symlink' ? 'symlink (not followed)' : type });
      if (recursive && type === 'dir') walk(full);
    }
  };
  walk(abs);
  return { entries, truncated };
}

/** A glob to a regex: `**` crosses directories, `*` and `?` do not. */
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function opSearch(dir, args) {
  const pattern = str(args, 'pattern');
  const path = str(args, 'path', false) ?? '.';
  const glob = str(args, 'glob', false);
  if (glob !== undefined) {
    const r = patternAllowed(glob);
    if (r) throw new Refused(r);
  }
  const abs = check('Grep', path, dir);
  let re;
  try {
    re = new RegExp(pattern, args.ignoreCase === true ? 'i' : '');
  } catch (err) {
    throw new BadArgs(`bad pattern: ${err.message}`);
  }
  const globRe = glob ? globRegex(glob) : null;
  const matches = [];
  const skipped = [];
  let files = 0;
  const visit = (full) => {
    const rel = relative(dir, full);
    if (globRe && !globRe.test(rel) && !globRe.test(rel.split('/').pop())) return;
    files += 1;
    let fd;
    try {
      ({ fd } = openFile(full, O_RDONLY));
    } catch {
      skipped.push(rel);
      return;
    }
    try {
      const st = fstatSync(fd);
      if (st.size > MAX_SEARCH_FILE) return;
      const text = readAll(fd, st.size, MAX_SEARCH_FILE).toString('utf8');
      if (text.includes('\0')) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 400) });
      }
    } finally {
      closeSync(fd);
    }
  };
  const walk = (at) => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      if (matches.length >= MAX_MATCHES || files >= MAX_SEARCH_FILES) return;
      const full = join(at, d.name);
      if (d.isSymbolicLink()) {
        skipped.push(relative(dir, full) + ' (symlink, not followed)');
        continue;
      }
      if (d.isDirectory()) {
        if (d.name.toLowerCase() === '.git' || d.name === 'node_modules') continue;
        walk(full);
      } else if (d.isFile()) visit(full);
    }
  };
  const st = lstatSync(abs);
  if (st.isDirectory()) walk(abs);
  else visit(abs);
  return { matches, truncated: matches.length >= MAX_MATCHES, skipped: skipped.slice(0, 50) };
}

const OPS = { read: opRead, write: opWrite, edit: opEdit, list: opList, search: opSearch };

function readStdin() {
  const chunks = [];
  let fd = 0;
  const buf = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_WRITE_BYTES * 2) throw new BadArgs('arguments too large');
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function main() {
  const [dir, op, rawArgs] = process.argv.slice(2);
  try {
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new BadArgs('dir must be an absolute path');
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw new BadArgs(`unknown op ${op}`);
    if (typeof rawArgs !== 'string') throw new BadArgs('missing arguments');
    const args = JSON.parse(rawArgs === '-' ? readStdin() : rawArgs);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new BadArgs('arguments must be an object');
    const result = OPS[op](dir, args);
    out({ ok: true, op, ...result }, 0);
  } catch (err) {
    if (err instanceof Refused) out({ ok: false, refused: err.message }, 3);
    else if (err instanceof BadArgs || err instanceof SyntaxError) out({ ok: false, error: err.message }, 2);
    else if (err && err.code === 'ELOOP') out({ ok: false, refused: 'The path is or passes through a symlink, which file tools never follow.' }, 3);
    else out({ ok: false, error: String(err && err.message) }, 1);
  }
}

main();
