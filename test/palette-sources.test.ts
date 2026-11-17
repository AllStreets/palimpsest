/**
 * The command palette's sources (Phase 5): small adapters over the same
 * live data the screens read. A repo connected, a firm founded, a job
 * posted or a graduate made appears with no change to the palette's code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PaletteApi, PaletteWays } from '../app/src/ui/palette-sources.js';
import { paletteSources, readAll } from '../app/src/ui/palette-sources.js';
import { SCHOOL_SECTIONS, SCREENS } from '../app/src/router.js';

type Any = Record<string, unknown>;

function world(data: { repos?: Any[]; city?: Any[]; firms?: Any[]; jobs?: Any[]; school?: Any; brief?: Any } = {}) {
  const calls: string[] = [];
  const ways = {
    went: [] as string[],
    standing: new Set<string>(),
    quarters: new Set<string>(),
  };
  const api = {
    repos: async () => data.repos ?? [],
    city: async () => data.city ?? [],
    firms: async () => data.firms ?? [],
    jobs: async () => data.jobs ?? [],
    school: async () => data.school ?? { nets: [], voyages: [], graduates: [], grants: [] },
    brief: async () => data.brief ?? { sections: { waiting: [], overnight: [], recommendations: [], city: [] } },
  } as unknown as PaletteApi;
  const w: PaletteWays = {
    navigate: (route, id = null) => calls.push(`navigate ${route}${id === null ? '' : ` ${id}`}`),
    flyToTower: (repo) => (ways.standing.has(repo) ? (calls.push(`fly ${repo}`), true) : false),
    flyToQuarter: (firmId) => (ways.quarters.has(firmId) ? (calls.push(`fly firm ${firmId}`), true) : false),
  };
  return { api, ways: w, calls, standing: ways.standing, quarters: ways.quarters };
}

const repo = (fullName: string, more: Any = {}): Any => ({ fullName, connected: true, status: 'ready', halted: null, ...more });
const floor = (state: string | null): Any => ({ id: `f${Math.random()}`, earned: state ? { state } : undefined });
const district = (fullName: string, floors: Any[]): Any => ({ repo: fullName, tower: { floors } });
const firm = (id: string, name: string, more: Any = {}): Any => ({ id, name, balance: 1240, status: 'active', agents: [], motto: '', ...more });
const agent = (id: string, name: string, firmId: string, more: Any = {}): Any => ({ id, name, firmId, model: 'ollama:qwen2.5-coder:7b', retired: false, ...more });
const job = (id: string, title: string, more: Any = {}): Any => ({ id, title, repo: 'acme/harbor-ledger', status: 'open', issue: null, ...more });

test('the sources stand in one list, each a kind with a label, a read and the events that make it stale', () => {
  const { api, ways } = world();
  const sources = paletteSources(api, ways);
  const kinds = sources.map((s) => s.kind);
  assert.deepEqual(kinds, ['screen', 'repo', 'firm', 'agent', 'job', 'net', 'voyage', 'graduate', 'grant', 'brief']);
  for (const s of sources) {
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.read, 'function');
    assert.equal(typeof s.stale, 'function');
  }
});

test('screens come from the router: every screen and the school sections but the master, each opening its route', async () => {
  const { api, ways, calls } = world();
  const screens = await paletteSources(api, ways).find((s) => s.kind === 'screen')!.read();
  assert.equal(screens.length, SCREENS.length + SCHOOL_SECTIONS.length - 1);
  assert.deepEqual(screens.slice(0, SCREENS.length).map((e) => e.name), SCREENS.map((s) => s.name));
  screens.find((e) => e.name === 'Treasury')!.go();
  screens.find((e) => e.name === 'Arenas')!.go();
  assert.deepEqual(calls, ['navigate treasury', 'navigate school arenas']);
  assert.equal(screens.some((e) => /master/i.test(e.name)), false, 'the master is a net, read live, not a static page');
});

test('a repo connected appears with no code change, with its floors as its state', async () => {
  const data = { repos: [repo('acme/harbor-ledger')], city: [district('acme/harbor-ledger', [floor(null), floor(null), floor('lit'), floor('waiting')])] };
  const { api, ways } = world(data);
  const src = paletteSources(api, ways).find((s) => s.kind === 'repo')!;
  let list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['acme/harbor-ledger', '4 floors, 1 lit']]);
  assert.deepEqual(list[0].keys, ['harbor-ledger', 'acme']);
  data.repos.push(repo('acme/quay', { status: 'analyzing' }));
  data.repos.push(repo('acme/off', { connected: false }));
  list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['acme/harbor-ledger', '4 floors, 1 lit'], ['acme/quay', 'Being analysed']]);
  assert.deepEqual(src.tally, [[2, 'district'], [4, 'floor']]);
  assert.equal(src.stale('repo.connected'), true);
  assert.equal(src.stale('floor.laid'), true);
  assert.equal(src.stale('firm.bankrupt'), false);
});

test('a repo says when it is halted, failed or not yet standing', async () => {
  const data = {
    repos: [repo('a/halted', { halted: { at: '', reason: 'three strikes' } }), repo('a/failed', { status: 'error' }), repo('a/new', { status: 'ready' })],
    city: [district('a/halted', [floor(null)])],
  };
  const { api, ways } = world(data);
  const list = await paletteSources(api, ways).find((s) => s.kind === 'repo')!.read();
  assert.deepEqual(list.map((e) => e.state), ['Halted, 1 floor', 'Analysis failed', 'Not standing yet']);
});

test('a repo flies the city to its tower when it stands, else opens its page', async () => {
  const data = { repos: [repo('acme/harbor-ledger'), repo('acme/quay')], city: [district('acme/harbor-ledger', [floor(null)])] };
  const { api, ways, calls, standing } = world(data);
  standing.add('acme/harbor-ledger');
  const list = await paletteSources(api, ways).find((s) => s.kind === 'repo')!.read();
  list[0].go();
  list[1].go();
  assert.deepEqual(calls, ['fly acme/harbor-ledger', 'navigate repo acme/quay']);
});

test('a firm founded appears with its balance and agents; it flies to its quarter when it stands, else opens its page', async () => {
  const data = { firms: [firm('f1', 'Lodestar', { agents: [agent('a1', 'Corin Hale', 'f1'), agent('a2', 'Old Hand', 'f1', { retired: true })] })] };
  const { api, ways, calls, quarters } = world(data);
  const src = paletteSources(api, ways).find((s) => s.kind === 'firm')!;
  let list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Lodestar', '1,240 credits, 1 agent']]);
  data.firms.push(firm('f2', 'Wrights', { balance: -12.5, status: 'bankrupt' }));
  list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Lodestar', '1,240 credits, 1 agent'], ['Wrights', 'Bankrupt']]);
  quarters.add('f1');
  list[0].go();
  list[1].go();
  assert.deepEqual(calls, ['fly firm f1', 'navigate firm f2']);
  assert.deepEqual(src.tally, [[2, 'firm']]);
  assert.equal(src.stale('firm.bankrupt'), true);
  assert.equal(src.stale('agent.hired'), true);
});

test('agents come from the firms, named with their firm and model, and open their page', async () => {
  const data = { firms: [firm('f1', 'Lodestar', { agents: [agent('a1', 'Corin Hale', 'f1'), agent('a2', 'Old Hand', 'f1', { retired: true, model: 'claude:sonnet' })] })] };
  const { api, ways, calls } = world(data);
  const src = paletteSources(api, ways).find((s) => s.kind === 'agent')!;
  const list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state, e.keys]), [
    ['Corin Hale', 'Lodestar, qwen2.5-coder:7b', ['Lodestar', 'qwen2.5-coder:7b']],
    ['Old Hand', 'Lodestar, retired', ['Lodestar', 'sonnet']],
  ]);
  list[0].go();
  assert.deepEqual(calls, ['navigate agent a1']);
  assert.deepEqual(src.tally, [[1, 'agent']], 'retired agents are not counted among the city\'s');
});

test('a job posted appears with its repo and stage; withdrawn jobs do not', async () => {
  const data = { jobs: [job('j1', 'Fix the quay lights', { status: 'running' }), job('j2', 'Gone', { status: 'withdrawn' })] };
  const { api, ways, calls } = world(data);
  const src = paletteSources(api, ways).find((s) => s.kind === 'job')!;
  let list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Fix the quay lights', 'harbor-ledger, under way']]);
  data.jobs.push(job('j3', 'Name the piers', { status: 'waiting', issue: 214 }));
  list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Fix the quay lights', 'harbor-ledger, under way'], ['Name the piers', 'harbor-ledger #214, waiting on you']]);
  assert.deepEqual(list[1].keys, ['acme/harbor-ledger', 'harbor-ledger', '#214']);
  list[1].go();
  assert.deepEqual(calls, ['navigate job j3']);
  assert.equal(src.stale('job.posted'), true);
  assert.equal(src.stale('run.stage'), true);
});

test('the school: nets with their trust, voyages with their place, a graduate made appears, grants where live', async () => {
  const data = {
    school: {
      nets: [
        { net: 'master', status: 'trusted', current: { version: 3, score: { value: 0.12 } } },
        { net: 'triage', status: 'thin', current: null },
      ],
      voyages: [{ id: 'v1', arena: 'ar1', repo: 'acme/harbor-ledger', status: 'sailing', generation: 2, of: 6, runs: { done: 3, of: 12 } }],
      graduates: [] as Any[],
      grants: [
        { kind: 'merge:low', repo: 'acme/harbor-ledger', state: 'granted', acted: 3 },
        { kind: 'merge:high', repo: 'acme/harbor-ledger', state: 'declined', acted: 0 },
        { kind: 'propose:harness', repo: 'acme/quay', state: 'asked', acted: 0 },
      ],
    },
  };
  const { api, ways, calls } = world(data);
  const sources = paletteSources(api, ways);
  const nets = await sources.find((s) => s.kind === 'net')!.read();
  assert.deepEqual(nets.map((e) => [e.name, e.state]), [['Master', 'Trusted at v3, score 0.12'], ['Triage', 'Thin']]);
  nets[0].go();
  nets[1].go();
  const voyages = await sources.find((s) => s.kind === 'voyage')!.read();
  assert.deepEqual(voyages.map((e) => [e.name, e.state]), [['Voyage on harbor-ledger', 'Sailing, generation 2 of 6']]);
  voyages[0].go();
  const grads = sources.find((s) => s.kind === 'graduate')!;
  assert.deepEqual(await grads.read(), []);
  data.school.graduates.push({ id: 'g1', model: 'mlx:qwen-lora-g1', base: 'qwen', vsBase: { diff: 0.08 }, examples: 112, at: '2026-11-01T00:00:00Z' });
  const list = await grads.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Graduate qwen-lora-g1', 'Beat its base by +0.08, 112 verified changes']]);
  list[0].go();
  const grants = await sources.find((s) => s.kind === 'grant')!.read();
  assert.deepEqual(grants.map((e) => [e.name, e.state]), [
    ['Low-tier merges on harbor-ledger', 'Granted, acted on 3 times'],
    ['Harness proposals on quay', 'Asked, waiting on you'],
  ]);
  grants[0].go();
  assert.deepEqual(calls, ['navigate school master', 'navigate net triage', 'navigate voyage v1', 'navigate graduate g1', 'navigate repo acme/harbor-ledger']);
  assert.equal(grads.stale('graduate.made'), true);
  assert.equal(sources.find((s) => s.kind === 'net')!.stale('net.promoted'), true);
});

test('the brief lends what waits on him, each opening the brief', async () => {
  const data = { brief: { sections: { waiting: [{ id: 'b1', title: 'Merge the quay lights?', kind: 'waiting' }], overnight: [{ id: 'b2', title: 'Overnight' }], recommendations: [], city: [] } } };
  const { api, ways, calls } = world(data);
  const src = paletteSources(api, ways).find((s) => s.kind === 'brief')!;
  const list = await src.read();
  assert.deepEqual(list.map((e) => [e.name, e.state]), [['Merge the quay lights?', 'Waiting in the brief']]);
  list[0].go();
  assert.deepEqual(calls, ['navigate brief']);
  assert.equal(src.stale('brief.action'), true);
});

test('readAll reads every source at once and a source that fails leaves the others standing', async () => {
  const data = { repos: [repo('acme/harbor-ledger')], firms: [firm('f1', 'Lodestar')] };
  const { api, ways } = world(data);
  (api as unknown as Any).jobs = async () => {
    throw new Error('engine away');
  };
  const sources = paletteSources(api, ways);
  const entries = await readAll(sources);
  assert.ok(entries.some((e) => e.kind === 'repo' && e.name === 'acme/harbor-ledger'));
  assert.ok(entries.some((e) => e.kind === 'firm'));
  assert.ok(entries.some((e) => e.kind === 'screen'));
  assert.equal(entries.some((e) => e.kind === 'job'), false);
});
