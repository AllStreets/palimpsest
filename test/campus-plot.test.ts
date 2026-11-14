/**
 * The university's plot (Phase 4 ruling 27, Decision 16): the campus takes
 * the next free plot of the district spiral once, keeps it across restarts,
 * and moves nothing already standing. Temp home only; the server listens on
 * an ephemeral port, never 4770.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner } from '../engine/exec.js';
import { home } from '../engine/home.js';
import { record } from '../engine/ledger.js';
import { nextSlot } from '../engine/repos.js';
import { SAMPLE_MARKER } from '../engine/sample.js';
import { bootSampleEngine } from '../engine/sample-boot.js';
import { campusOrigin, campusSlot, ensureCampus } from '../engine/school/campus.js';
import { startServer, type StartedServer } from '../engine/server.js';
import { districtOrigin } from '../shared/district-layout.js';
import { setUp, tearDown, tempDir } from './guild-fixtures.js';

let server: StartedServer | null = null;

beforeEach(() => setUp('campus'));

afterEach(async () => {
  if (server) await server.close();
  server = null;
  await tearDown();
});

function slots(): Array<{ kind: string; owner: string; slot: number }> {
  return (openDb().prepare('SELECT kind, owner, slot FROM slots ORDER BY slot').all() as Array<{ kind: string; owner: string; slot: number }>).map((r) => ({ ...r, slot: Number(r.slot) }));
}

test('ensureCampus takes the next slot once, the same slot again on restart, and moves no district', () => {
  // Two districts and a firm's quarter already stand.
  assert.equal(nextSlot('repo', 'acme/widgets'), 0);
  assert.equal(nextSlot('firm', 'quickset'), 1);
  assert.equal(nextSlot('repo', 'acme/gears'), 2);
  const before = slots();
  // Asking where it stands takes nothing.
  assert.equal(campusSlot(), null);
  assert.equal(campusOrigin(), null);
  assert.deepEqual(slots(), before);

  const slot = ensureCampus();
  assert.equal(slot, 3, 'the next free plot on the spiral');
  assert.equal(campusSlot(), 3);
  assert.deepEqual(campusOrigin(), districtOrigin(3));
  // Every plot already held is where it was.
  assert.deepEqual(slots().filter((r) => r.kind !== 'campus'), before);
  assert.deepEqual(slots().find((r) => r.kind === 'campus'), { kind: 'campus', owner: 'university', slot: 3 });

  // A restart (the engine calls it at every start) keeps the plot and takes no other.
  assert.equal(ensureCampus(), 3);
  assert.equal(ensureCampus(), 3);
  assert.equal(slots().filter((r) => r.kind === 'campus').length, 1);

  // A repo connected after the campus takes the plot past it.
  assert.equal(nextSlot('repo', 'acme/sprockets'), 4);
  assert.equal(ensureCampus(), 3);
});

async function getCampus(): Promise<{ status: number; body: unknown }> {
  server ??= await startServer({ port: 0, claudeSettingsPath: join(tempDir, 'claude-settings.json'), keychain: join(tempDir, 'fake.keychain-db') });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/school/campus`);
  return { status: res.status, body: (await res.json()) as unknown };
}

test('a GET on a fresh home takes no slot and answers that there is no campus yet', async () => {
  nextSlot('repo', 'acme/widgets');
  const before = slots();
  const first = await getCampus();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { origin: null, slot: null, live: { voyage: false, nets: false, lora: false }, voyage: null, voyageRepo: null });
  await getCampus();
  assert.deepEqual(slots(), before, 'reading the campus never takes a plot');
  assert.equal(campusSlot(), null);
});

test('GET /api/school/campus answers the origin of the slot the engine took', async () => {
  nextSlot('repo', 'acme/widgets');
  nextSlot('firm', 'quickset');
  const slot = ensureCampus();
  assert.equal(slot, 2);
  const { status, body } = await getCampus();
  assert.equal(status, 200);
  assert.deepEqual(body, { origin: districtOrigin(2), slot: 2, live: { voyage: false, nets: false, lora: false }, voyage: null, voyageRepo: null });
  // It is a read: a write to it is not a route.
  const post = await fetch(`http://127.0.0.1:${server!.port}/api/school/campus`, { method: 'POST', headers: { 'x-palimpsest': '1' } });
  assert.equal(post.status, 404);
});

test('a sample engine takes the campus plot at start, once', async () => {
  // A sample home: gh and ollama are the sample stand-in, never the real ones.
  writeFileSync(join(home(), SAMPLE_MARKER), '{}');
  try {
    assert.equal(campusSlot(), null);
    await bootSampleEngine();
    const slot = campusSlot();
    assert.notEqual(slot, null, 'the sample engine took the plot');
    await bootSampleEngine();
    assert.equal(campusSlot(), slot);
    assert.equal(slots().filter((r) => r.kind === 'campus').length, 1);
  } finally {
    setRunner(realRunner);
  }
});

test('a voyage sailing in the ledger shows as live on the campus', async () => {
  ensureCampus();
  const voyage = { id: 'voy-1', arena: 'arena-1', status: 'sailing', generation: 1, of: 4, runs: { done: 3, of: 480 }, commissionedBy: null, scores: [], promoted: [], sealed: null, credits: 0, startedAt: '2026-11-11T22:00:00Z', endedAt: null };
  record('voyage.started', { voyageId: 'voy-1', voyage });
  let { body } = await getCampus();
  assert.deepEqual((body as { live: unknown }).live, { voyage: true, nets: false, lora: false });
  assert.deepEqual((body as { voyage: unknown }).voyage, voyage);
  assert.equal((body as { voyageRepo: unknown }).voyageRepo, null);
  record('voyage.generation', { voyageId: 'voy-1', voyage, repo: 'acme/widgets' });
  assert.equal(((await getCampus()).body as { voyageRepo: unknown }).voyageRepo, 'acme/widgets');
  // Its generation moves on; the campus carries the newest word on it.
  record('voyage.generation', { voyageId: 'voy-1', voyage: { ...voyage, generation: 2 } });
  body = (await getCampus()).body;
  assert.equal((body as { voyage: { generation: number } }).voyage.generation, 2);
  // Ended, there is no live voyage.
  record('voyage.ended', { voyageId: 'voy-1', voyage: { ...voyage, status: 'done', endedAt: '2026-11-13T04:00:00Z' } });
  body = (await getCampus()).body;
  assert.deepEqual((body as { live: unknown }).live, { voyage: false, nets: false, lora: false });
  assert.equal((body as { voyage: unknown }).voyage, null);
});
