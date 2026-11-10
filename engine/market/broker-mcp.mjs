/**
 * The run tool's MCP server (ruling 19): a minimal stdio JSON-RPC 2.0
 * server, started by the claude CLI under the CLI profile as
 *
 *   node broker-mcp.mjs <ctl>/broker.json <ctl>/broker.token
 *
 * It exposes one tool, `run`, and forwards each call over loopback to the
 * run's broker with the run's bearer token, read from its file (never from
 * an argv). Returns stdout, stderr and the exit code as text, or the refusal.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const [brokerJson, brokerToken] = process.argv.slice(2);

const TOOL = {
  name: 'run',
  description: 'Run a shell command in the repository. The city refuses pushes, credentials and anything outside the repository.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command, run with /bin/sh -c in the repository.' },
      timeoutMs: { type: 'number', description: 'How long it may run, in milliseconds (at most 15 minutes).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function brokerTarget() {
  const { port } = JSON.parse(readFileSync(brokerJson, 'utf8'));
  const token = readFileSync(brokerToken, 'utf8').trim();
  if (!Number.isInteger(port) || !token) throw new Error('the broker is not running');
  return { port, token };
}

function forward(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { port, token } = brokerTarget();
    const body = JSON.stringify(timeoutMs === undefined ? { command } : { command, timeoutMs });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/run',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`the broker answered ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('the broker answered with something unreadable'));
          }
        });
      },
    );
    req.setTimeout(16 * 60_000, () => req.destroy(new Error('the broker did not answer')));
    req.on('error', reject);
    req.end(body);
  });
}

function asText(r) {
  if (r.refused) return { text: `Refused by the city: ${r.refused}`, isError: true };
  const parts = [];
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  parts.push(`exit code ${r.code === null ? 'none (killed)' : r.code}`);
  return { text: parts.join('\n'), isError: r.code !== 0 };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'palimpsest', version: '1.0.0' },
      });
      return;
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call': {
      if (params?.name !== 'run') {
        fail(id, -32602, `unknown tool ${String(params?.name)}`);
        return;
      }
      const args = params.arguments ?? {};
      if (typeof args.command !== 'string' || (args.timeoutMs !== undefined && typeof args.timeoutMs !== 'number')) {
        reply(id, { content: [{ type: 'text', text: 'run needs a command string (and optionally a timeoutMs number)' }], isError: true });
        return;
      }
      try {
        const { text, isError } = asText(await forward(args.command, args.timeoutMs));
        reply(id, { content: [{ type: 'text', text }], isError });
      } catch (err) {
        reply(id, { content: [{ type: 'text', text: `The command did not run: ${err.message}` }], isError: true });
      }
      return;
    }
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'parse error');
      continue;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) fail(msg.id, -32603, String(err && err.message));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
