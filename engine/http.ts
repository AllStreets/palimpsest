import type { IncomingMessage, ServerResponse } from 'node:http';

/** A failure that maps to a specific HTTP status (not-found, a refused input, a conflict), not a 500. */
export class HttpError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(typeof body === 'object' && body !== null && 'error' in body ? String((body as { error: unknown }).error) : String(body));
    this.status = status;
    this.body = body;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads and parses a JSON request body; an empty body parses as `{}`. Throws HttpError(400) on malformed JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, { error: 'invalid JSON body' });
  }
}

/** The body as a plain object, or a 400. */
export async function readObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, { error: 'expected a JSON object' });
  return body as Record<string, unknown>;
}
