/**
 * The design check's static server (Task 15, ruling 24), plain JS so it
 * runs from `<runRoot>/ctl/bin` under the tool profile like any agent
 * command. It serves one directory on a loopback port the kernel picks,
 * prints `PALIMPSEST_SERVING <port>` once listening, answers GET and HEAD
 * only, never follows a path out of its root (`..`, a symlink that leaves
 * it), falls back to the root `index.html` for extensionless routes (an
 * app's client-side routes), and exits on its own after its lifetime.
 *
 * Usage: node static-server.mjs <root> [lifetimeMs]
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const root = realpathSync(process.argv[2] ?? '.');
const lifetime = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 10 * 60_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const inside = (p) => p === root || p.startsWith(root + sep);

/** The real path a request names, inside the root, or null. */
function locate(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const abs = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (!inside(abs)) return null;
  try {
    const real = realpathSync(abs);
    return inside(real) ? real : null;
  } catch {
    return null;
  }
}

/** A regular file's bytes (a directory gives its index.html), or null. */
function read(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (st.isDirectory()) {
      closeSync(fd);
      fd = undefined;
      const index = locate(`${path.slice(root.length)}/index.html`);
      return index ? read(index) : null;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return { path, body: buf.subarray(0, off) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = req.url ?? '/';
  let found = null;
  const at = locate(url);
  if (at) found = read(at);
  if (!found && !extname(url.split('?')[0])) {
    const index = locate('/index.html');
    if (index) found = read(index);
  }
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(found.path).toLowerCase()] ?? 'application/octet-stream', 'content-length': found.body.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : found.body);
});

server.listen(0, '127.0.0.1', () => {
  const a = server.address();
  process.stdout.write(`PALIMPSEST_SERVING ${typeof a === 'object' && a ? a.port : 0}\n`);
});
setTimeout(() => process.exit(0), lifetime);
