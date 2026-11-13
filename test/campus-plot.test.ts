/**
 * The university's plot (Phase 4 ruling 27, Decision 16): the campus takes
 * the next free plot of the district spiral once, keeps it across restarts,
 * and moves nothing already standing. Temp home only; the server listens on
 * an ephemeral port, never 4770.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { nextSlot } from '../engine/repos.js';
import { campusOrigin, ensureCampus } from '../engine/school/campus.js';
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

  const slot = ensureCampus();
  assert.equal(slot, 3, 'the next free plot on the spiral');
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

test('GET /api/school/campus answers the origin of that slot', async () => {
  nextSlot('repo', 'acme/widgets');
  nextSlot('firm', 'quickset');
  const slot = ensureCampus();
  server = await startServer({ port: 0, claudeSettingsPath: join(tempDir, 'claude-settings.json'), keychain: join(tempDir, 'fake.keychain-db') });
  const res = await fetch(`http://127.0.0.1:${server.port}/api/school/campus`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as unknown;
  assert.deepEqual(body, { origin: districtOrigin(slot), slot, live: { voyage: false, nets: false, lora: false } });
  // Reading it takes no other plot.
  await fetch(`http://127.0.0.1:${server.port}/api/school/campus`);
  assert.equal(ensureCampus(), slot);
  // It is a read: a write to it is not a route.
  const post = await fetch(`http://127.0.0.1:${server.port}/api/school/campus`, { method: 'POST', headers: { 'x-palimpsest': '1' } });
  assert.equal(post.status, 404);
});
