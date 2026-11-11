/**
 * The per-run egress proxy (ruling 21): an HTTP CONNECT and plain HTTP
 * forward proxy on a loopback port. It answers 407 to any request without
 * this run's own token, allows a host only when the current stage lists it
 * (an exact host or a `*.suffix`), answers 403 otherwise, and logs every
 * decision to the run log as an `egress` line.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import { REGISTRY_HOSTS } from '../../shared/market-rules.js';
import { paths } from '../home.js';
import type { RunLogLine } from './provider.js';
import { registerRunPorts, unregisterRunPorts } from './sandbox.js';

export type EgressStage = 'install' | 'working' | 'checks';

/** True for a host Anthropic owns (its API, claude.ai, claude.com and their subdomains): a refusal of one during a Claude run is a login problem, not the agent's. */
export function isAnthropicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return ['anthropic.com', 'claude.ai', 'claude.com'].some((d) => h === d || h.endsWith('.' + d));
}

/** Hosts each run's proxy refused for not being listed, by run id, since its proxy started. */
const refused = new Map<string, string[]>();

/** The hosts this run's proxy refused because its stage did not list them, in order, without repeats. */
export function refusedHosts(runId: string): string[] {
  return [...(refused.get(runId) ?? [])];
}

/**
 * The hosts a Claude run needs. The Task 11 smoke run on his login (claude
 * 2.1.319, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1) made CONNECTs to
 * api.anthropic.com only. A login refresh may need more; any host it asks
 * for is refused and logged, never added silently.
 */
export const CLAUDE_HOSTS: string[] = ['api.anthropic.com'];

/** Registries by ecosystem (ruling 21); kept in shared/ so the district page names the same hosts. */
export { REGISTRY_HOSTS };

/**
 * The hosts a stage allows (ruling 21): `install` the ecosystems'
 * registries; `working` those plus the model provider for a Claude run;
 * `checks` (also the design check and the push-mode recheck) nothing.
 */
export function hostsFor(
  stage: EgressStage | 'design' | 'recheck',
  ecosystems: Array<keyof typeof REGISTRY_HOSTS>,
  model: string | null,
): string[] {
  if (stage !== 'install' && stage !== 'working') return [];
  const hosts = ecosystems.flatMap((e) => REGISTRY_HOSTS[e] ?? []);
  if (stage === 'working' && model?.startsWith('claude:')) hosts.push(...CLAUDE_HOSTS);
  return [...new Set(hosts)];
}

/** True when `host` is listed exactly, or under a listed `*.suffix`. */
export function hostAllowed(host: string, list: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const entry of list) {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) {
      if (h.endsWith(e.slice(1)) && h.length > e.length - 1) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

/** Splits `host:port` (with `[v6]:port`), defaulting the port. */
function splitHostPort(s: string, defPort: number): { host: string; port: number } | null {
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  let password: string;
  try {
    password = decodeURIComponent(decoded.slice(colon + 1));
  } catch {
    return false;
  }
  const given = Buffer.from(password);
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface Egress {
  port: number;
  token: string;
  setStage(stage: EgressStage, hosts: string[]): void;
  close(): Promise<void>;
}

/**
 * Starts the run's proxy on 127.0.0.1:0 with stage `checks` (nothing
 * allowed) until the runner sets one. Writes the token to
 * `<ctl>/egress.token` (mode 0400) and the port to `<ctl>/egress.json`.
 */
/** Ports a tunnel or a forward may reach: CONNECT only to 443 and plain HTTP only to 80 unless a test stands in another. */
export interface EgressPorts {
  connectPorts: number[];
  httpPorts: number[];
}

export const DEFAULT_EGRESS_PORTS: EgressPorts = { connectPorts: [443], httpPorts: [80] };

export async function startEgress(runId: string, log: (line: RunLogLine) => void, ports: EgressPorts = DEFAULT_EGRESS_PORTS): Promise<Egress> {
  const ctl = join(paths().runs, runId, 'ctl');
  mkdirSync(ctl, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const tokenPath = join(ctl, 'egress.token');
  try {
    unlinkSync(tokenPath);
  } catch {
    // first start
  }
  writeFileSync(tokenPath, token, { mode: 0o400 });
  chmodSync(tokenPath, 0o400);

  refused.set(runId, []);
  let stage: EgressStage = 'checks';
  let allowed: string[] = [];
  const sockets = new Set<Socket | Duplex>();
  /** Open tunnels by host, so a stage change closes the ones the new list no longer allows. */
  const tunnels = new Map<Duplex, string>();

  const note = (allowedNow: boolean, method: string, host: string, port: number, reason: string) => {
    log({
      at: new Date().toISOString(),
      kind: 'egress',
      text: `${allowedNow ? 'allowed' : 'refused'} ${method} ${host}:${port} (${stage}${allowedNow ? '' : `, ${reason}`})`,
      data: { allowed: allowedNow, method, host, port, stage, reason },
    });
  };

  const noteRefused = (host: string) => {
    const list = refused.get(runId) ?? [];
    const h = host.toLowerCase();
    if (!list.includes(h) && list.length < 100) list.push(h);
    refused.set(runId, list);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP forward: the request line carries an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      note(false, req.method ?? 'GET', '?', 0, 'not a proxy request');
      res.writeHead(400).end('bad proxy request\n');
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : 80;
    if (!tokenOk(req.headers['proxy-authorization'], token)) {
      note(false, req.method ?? 'GET', host, port, 'no token for this run');
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="palimpsest"' }).end('proxy authentication required\n');
      return;
    }
    if (url.protocol !== 'http:' || !ports.httpPorts.includes(port)) {
      note(false, req.method ?? 'GET', host, port, 'port not allowed');
      res.writeHead(403).end('port not allowed\n');
      return;
    }
    if (!hostAllowed(host, allowed)) {
      noteRefused(host);
      note(false, req.method ?? 'GET', host, port, 'host not allowed in this stage');
      res.writeHead(403).end('host not allowed in this stage\n');
      return;
    }
    note(true, req.method ?? 'GET', host, port, 'listed');
    // The Host header names the target, never what the client claimed.
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = httpRequest(
      { host, port, method: req.method, path: url.pathname + url.search, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    const target = splitHostPort(req.url ?? '', 443);
    if (!target) {
      note(false, 'CONNECT', req.url ?? '?', 0, 'bad target');
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (!tokenOk(req.headers['proxy-authorization'], token)) {
      note(false, 'CONNECT', target.host, target.port, 'no token for this run');
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="palimpsest"\r\n\r\n');
      return;
    }
    if (!ports.connectPorts.includes(target.port)) {
      note(false, 'CONNECT', target.host, target.port, 'port not allowed');
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (!hostAllowed(target.host, allowed)) {
      noteRefused(target.host);
      note(false, 'CONNECT', target.host, target.port, 'host not allowed in this stage');
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    note(true, 'CONNECT', target.host, target.port, 'listed');
    tunnels.set(client, target.host);
    client.on('close', () => tunnels.delete(client));
    const up = connect(target.port, target.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up);
    up.on('close', () => {
      sockets.delete(up);
      client.destroy();
    });
    client.on('close', () => up.destroy());
    up.on('error', () => {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });

  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  writeFileSync(join(ctl, 'egress.json'), JSON.stringify({ port }) + '\n');
  registerRunPorts(runId, [port]);

  return {
    port,
    token,
    setStage(next, hosts) {
      stage = next;
      allowed = next === 'checks' ? [] : [...hosts];
      for (const [client, host] of tunnels) {
        if (!hostAllowed(host, allowed)) client.destroy();
      }
      log({ at: new Date().toISOString(), kind: 'egress', text: `stage ${next}: ${allowed.length ? allowed.join(', ') : 'nothing allowed'}`, data: { stage: next, hosts: allowed } });
    },
    async close() {
      unregisterRunPorts(runId, [port]);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
