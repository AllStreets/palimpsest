/**
 * The school roster and commissions (Phase 4 Task 23, ruling 22): a
 * champion that beat every seeded local agent joins the roster with origin
 * `school`, and a firm with at least 400 credits, an idle agent and a floor
 * on an arena's repo may pay the school 120 credits to sail a voyage there
 * first. Fake voyages and arenas written to a temp home; no Beagle, no model.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe, type Event } from '../engine/events.js';
import { entries, query } from '../engine/ledger.js';
import { hire, ROSTER, rosterSeeds } from '../engine/market/firms.js';
import { verifyReplay } from '../engine/market/replay.js';
import { balances, replayBalances } from '../engine/market/treasury.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { commission, CommissionRefused, firstRefusal, installRoster, schoolRoster } from '../engine/school/roster.js';
import { dueArenas, voyages } from '../engine/school/voyages.js';
import { COMMISSION } from '../shared/school-rules.js';
import { addAgent, HOUR, setUp, tearDown } from './guild-fixtures.js';
import { bredVoyage, championBody, firmWith, floorOn, graduate, LOCAL, readyArena } from './roster-fixtures.js';

const NOW = Date.parse('2026-11-12T09:00:00.000Z');
const DAY = 24 * HOUR;
const REPO = 'acme/widgets';

let events: Event[] = [];
let unsubscribe: () => void = () => {};
let uninstall: () => void = () => {};

beforeEach(() => {
  setUp('school-roster');
  patchSettings({ school: { ...getSettings().school, enabled: true } });
  events = [];
  unsubscribe = subscribe((e) => events.push(e));
});

afterEach(async () => {
  unsubscribe();
  uninstall();
  await tearDown();
});

/** A firm with `balance` on its books, one idle agent and a floor on REPO. */
function commissioner(id: string, balance: number): void {
  firmWith(id, balance);
  addAgent(`${id}-1`, id, LOCAL);
  floorOn(`${id}-1`, REPO);
}

function creditRows(): Array<{ firm_id: string | null; run_id: string | null; kind: string; amount: number; json: string }> {
  return openDb().prepare('SELECT firm_id, run_id, kind, amount, json FROM credits ORDER BY id').all() as never;
}

// ---------------------------------------------------------------- the roster

test('a school-bred champion appears on the roster with origin school', () => {
  uninstall = installRoster({ trusted: () => true, graduates: () => [graduate('grad-7')] });
  firmWith('quill', 300);
  addAgent('seed-1', 'quill', LOCAL, { capability: 'glass', bidsOn: ['low'], maxTurns: 25 });
  readyArena('arena-1', REPO);
  bredVoyage({ id: 'v-1', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-sharp', endedAt: new Date(NOW - DAY).toISOString() });
  // no claim, still sailing, or a seeded agent as the best: none of these joins
  bredVoyage({ id: 'v-2', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-weak', endedAt: new Date(NOW - DAY).toISOString(), claim: false });
  bredVoyage({ id: 'v-3', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-live', endedAt: new Date(NOW - DAY).toISOString(), status: 'paused' });

  const seeds = schoolRoster();
  assert.deepEqual(
    seeds.map((s) => s.id),
    ['bred-g-sharp', 'grad-grad-7'],
  );
  const bred = seeds[0];
  assert.equal(bred.name, 'Sharp One');
  assert.equal(bred.model, LOCAL);
  assert.equal(bred.origin, 'school');
  assert.deepEqual(bred.workflow, { shape: 'self-check' });
  assert.equal(bred.examples, 2);
  // its era, tiers and turns are its first ancestor's, a seeded agent of the city
  assert.equal(bred.capability, 'glass');
  assert.deepEqual(bred.bidsOn, ['low']);
  assert.equal(bred.maxTurns, 25);
  assert.equal(bred.persona?.body.trim(), championBody('g-sharp').instructions);
  assert.match(bred.persona?.line ?? '', /acme\/widgets/);
  const grad = seeds[1];
  assert.equal(grad.model, 'mlx:qwen2.5-coder-7b-lora-1');
  assert.equal(grad.origin, 'school');
  assert.ok(grad.name.length > 0);

  // the roster reads them after the hand-written specialists
  const all = rosterSeeds();
  assert.deepEqual(all.slice(0, ROSTER.length), ROSTER);
  assert.deepEqual(all.slice(ROSTER.length).map((s) => s.id), ['bred-g-sharp', 'grad-grad-7']);

  // hired, the champion is an agent of school lineage
  const a = hire('quill', new Date(NOW));
  assert.ok(a);
  assert.equal(a.id, 'bred-g-sharp');
  assert.equal(a.lineage.origin, 'school');
  assert.deepEqual(a.lineage.parents, ['mid']);
  assert.equal(a.lineage.generation, 3);
  assert.equal(a.model, LOCAL);
  assert.equal(a.instructions.trim(), championBody('g-sharp').instructions);
  assert.equal(a.firmId, 'quill');
  assert.ok(a.tools.length > 0, 'hired into the market, it gets the market\'s tools');
  const hired = query({ kind: ['agent.hired'] }).map((e) => (e.data as { agent: { id: string } }).agent.id);
  assert.deepEqual(hired, ['bred-g-sharp']);
  // the graduate comes next, then the hand-written roster
  assert.equal(hire('quill', new Date(NOW))?.id, 'grad-grad-7');
  assert.equal(hire('quill', new Date(NOW))?.id, ROSTER[0].id);
});

test('with nothing installed the roster is the hand-written one', () => {
  firmWith('quill', 300);
  addAgent('seed-1', 'quill', LOCAL);
  readyArena('arena-1', REPO);
  bredVoyage({ id: 'v-1', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-sharp', endedAt: new Date(NOW - DAY).toISOString() });
  assert.deepEqual(rosterSeeds(), ROSTER);
  assert.equal(hire('quill', new Date(NOW))?.id, ROSTER[0].id);
});

// ---------------------------------------------------------------- commissions

test('a firm with 390 credits cannot commission', () => {
  uninstall = installRoster({ trusted: () => true });
  commissioner('quill', 390);
  readyArena('arena-1', REPO);
  assert.throws(() => commission('quill', 'arena-1', NOW), (err: unknown) => err instanceof CommissionRefused && /400 credits/.test(err.message));
  assert.deepEqual(creditRows(), []);
  assert.deepEqual(voyages(), []);
  assert.equal(query({ kind: ['voyage.commissioned'] }).length, 0);
  assert.equal(query({ kind: ['credits.moved'] }).length, 0);
  assert.equal(balances().quill, 390);

  // 400 is enough
  commissioner('rook', 400);
  const v = commission('rook', 'arena-1', NOW);
  assert.equal(v.commissionedBy, 'rook');
  assert.equal(balances().rook, 400 - COMMISSION.fee);
});

test('a commission is refused without an idle agent, a floor on the repo, a ready arena or the school', () => {
  uninstall = installRoster({ trusted: () => true });
  readyArena('arena-1', REPO);
  readyArena('arena-other', 'acme/other');
  readyArena('arena-spent', REPO, { status: 'spent', sealedUses: 10 });
  commissioner('quill', 500);
  // no floor on the other repo
  assert.throws(() => commission('quill', 'arena-other', NOW), /floor on acme\/other/);
  assert.throws(() => commission('quill', 'arena-spent', NOW), /not ready/);
  assert.throws(() => commission('quill', 'arena-none', NOW), /no arena/);
  assert.throws(() => commission('nobody', 'arena-1', NOW), /no firm/);
  // no idle agent: its only agent is retired
  firmWith('rook', 500);
  addAgent('rook-1', 'rook', LOCAL, { retired: true, retiredReason: 'left' });
  floorOn('rook-1', REPO);
  assert.throws(() => commission('rook', 'arena-1', NOW), /idle agent/);
  patchSettings({ school: { ...getSettings().school, enabled: false } });
  assert.throws(() => commission('quill', 'arena-1', NOW), /school is off/);
  assert.deepEqual(creditRows(), []);
  assert.deepEqual(voyages(), []);
});

test('a commission moves 120 credits and queues the voyage first', () => {
  uninstall = installRoster({ trusted: () => true });
  commissioner('quill', 500);
  commissioner('rook', 500);
  // an older ready arena never voyaged, and an older voyage paused on a third arena: both would sail before it uncommissioned
  readyArena('arena-old', 'acme/old', { builtAt: '2026-10-01T00:00:00.000Z' });
  readyArena('arena-paused', 'acme/paused', { builtAt: '2026-10-02T00:00:00.000Z' });
  const paused = bredVoyage({ id: 'v-paused', arena: 'arena-paused', repo: 'acme/paused', starter: 'seed-x', genome: 'g-x', endedAt: new Date(NOW - 2 * DAY).toISOString(), status: 'paused' });
  readyArena('arena-1', REPO, { builtAt: '2026-11-11T00:00:00.000Z' });
  assert.deepEqual(dueArenas(NOW), ['arena-paused', 'arena-old', 'arena-1']);

  const view = commission('quill', 'arena-1', NOW);

  // the voyage, queued with its id known now
  assert.match(view.id, /^v-2026-11-12-[0-9a-f]{6}$/);
  assert.equal(view.arena, 'arena-1');
  assert.equal(view.repo, REPO);
  assert.equal(view.commissionedBy, 'quill');
  assert.equal(view.status, 'paused');
  assert.deepEqual(view.scores, []);
  assert.equal(view.credits, 0);
  assert.match(view.reason ?? '', /Commissioned by Quill/);
  assert.deepEqual(voyages().find((v) => v.id === view.id), view);
  assert.deepEqual(dueArenas(NOW), ['arena-1', 'arena-paused', 'arena-old']);
  assert.equal(paused.commissionedBy, null);

  // the fee: one credits row, the firm's, outside the voyage's own spend
  const rows = creditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firm_id, 'quill');
  assert.equal(rows[0].kind, 'commission');
  assert.equal(rows[0].amount, COMMISSION.fee);
  assert.equal(rows[0].run_id, null, 'the fee is not a row of the voyage');
  assert.equal(JSON.parse(rows[0].json).voyageId, view.id);
  assert.equal(balances().quill, 500 - COMMISSION.fee);
  assert.equal(balances().rook, 500);

  // credits.moved, then voyage.commissioned, each once, recorded and emitted
  const moved = query({ kind: ['credits.moved'] }).map((e) => e.data as Record<string, unknown>);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].from, 'quill');
  assert.equal(moved[0].to, 'city');
  assert.equal(moved[0].amount, COMMISSION.fee);
  assert.equal(moved[0].delta, -COMMISSION.fee);
  assert.equal(moved[0].reason, 'commission');
  assert.equal(moved[0].voyageId, view.id);
  assert.equal(moved[0].kind, 'commission');
  const c = query({ kind: ['voyage.commissioned'] }).map((e) => e.data as Record<string, unknown>);
  assert.equal(c.length, 1);
  assert.equal(c[0].voyageId, view.id);
  assert.equal(c[0].firmId, 'quill');
  assert.equal(c[0].fee, COMMISSION.fee);
  assert.deepEqual(c[0].voyage, view);
  assert.deepEqual(
    events.filter((e) => e.type === 'credits.moved' || e.type === 'voyage.commissioned').map((e) => e.type),
    ['credits.moved', 'voyage.commissioned'],
  );
  assert.deepEqual(events.find((e) => e.type === 'voyage.commissioned')?.data, c[0]);
  // the commission is not a voyage's start: the city's live voyage is untouched until it sails
  assert.equal(events.filter((e) => e.type === 'voyage.started').length, 0);

  // the books and the voyages replay from the ledger
  assert.deepEqual(replayBalances(entries()).quill, balances().quill);
  assert.deepEqual(verifyReplay().diffs.filter((d) => /^(voyage|arena|firm|balance)/.test(d)), []);

  // at most one commissioned voyage is live: another firm, or another arena, waits
  readyArena('arena-2', REPO);
  assert.throws(() => commission('rook', 'arena-2', NOW + HOUR), /commissioned voyage is already/);
  // and an arena with a voyage under way is not ready for a commission
  assert.throws(() => commission('rook', 'arena-paused', NOW + HOUR), /voyage under way/);
  assert.equal(creditRows().length, 1);
  assert.equal(query({ kind: ['voyage.commissioned'] }).length, 1);
});

test('first refusal names the commissioning firm for 7 days after its voyage ends', () => {
  uninstall = installRoster({ trusted: () => true });
  firmWith('quill', 300);
  addAgent('seed-1', 'quill', LOCAL);
  readyArena('arena-1', REPO);
  const ended = NOW - DAY;
  bredVoyage({ id: 'v-1', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-sharp', endedAt: new Date(ended).toISOString(), commissionedBy: 'quill' });
  bredVoyage({ id: 'v-2', arena: 'arena-1', repo: REPO, starter: 'seed-1', genome: 'g-free', endedAt: new Date(ended).toISOString() });
  assert.equal(firstRefusal('bred-g-sharp', NOW), 'quill');
  assert.equal(firstRefusal('bred-g-sharp', ended + COMMISSION.firstRefusalDays * DAY - 1), 'quill');
  assert.equal(firstRefusal('bred-g-sharp', ended + COMMISSION.firstRefusalDays * DAY), null);
  assert.equal(firstRefusal('bred-g-free', NOW), null, 'nobody commissioned it');
  assert.equal(firstRefusal('dagny-hollis', NOW), null, 'a hand-written specialist');
  assert.equal(firstRefusal('nobody', NOW), null);
});
