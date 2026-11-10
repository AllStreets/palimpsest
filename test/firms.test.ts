import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import {
  agent,
  firm,
  hire,
  idleAgents,
  installedModels,
  listAgents,
  listFirms,
  quarters,
  resolveModel,
  retireAgent,
  retireFirm,
  ROSTER,
  SEED_FIRMS,
  seedFirms,
  sellTower,
  toGenome,
} from '../engine/market/firms.js';
import { layEarnedFloor } from '../engine/repos.js';
import { startServer } from '../engine/server.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Agent, Floor, Repo } from '../shared/types.js';

/** What `ollama list` showed on his Mac on 2026-11-09 (plan header). */
const INSTALLED = [
  'qwen3-coder:30b-a3b-q4_K_M',
  'gpt-oss:20b',
  'qwen2.5-coder:7b',
  'qwen3:1.7b',
  'qwen2.5vl:7b',
  'llama3.1:8b',
  'llama3.2:latest',
  'nomic-embed-text:latest',
];

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-firms-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  setRunner(realRunner);
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function storeRepo(fullName: string, slot: number): void {
  const repo: Repo = {
    fullName,
    private: false,
    defaultBranch: 'main',
    language: null,
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot,
    status: 'ready',
    error: null,
    connectedAt: new Date(Date.UTC(2026, 0, 1 + slot)).toISOString(),
    analyzedAt: null,
    ...repoMarketDefaults(),
  };
  openDb().prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(fullName, JSON.stringify(repo));
}

/** A copy of Beagle's genome validate() (beagle/src/genome.ts), with Palimpsest's tool names as the arena's tools. */
const SHAPES = ['single', 'plan-then-answer', 'self-check', 'vote'];
function beagleValidate(x: unknown, tools: string[]): void {
  const g = x as {
    id?: string;
    name?: string;
    model?: unknown;
    instructions?: unknown;
    tools?: unknown;
    workflow?: { shape?: string; n?: number };
    memory?: { examples?: number };
  };
  if (!g || typeof g !== 'object') throw new Error('not a genome');
  const bad = (why: string): never => {
    throw new Error(`genome "${g.name ?? g.id ?? '?'}": ${why}`);
  };
  if (!g.id || !g.name) bad('needs an id and a name');
  if (typeof g.model !== 'string' || !/^(claude|ollama):\S+$/.test(g.model)) bad('model must be claude:<name> or ollama:<name>');
  if (typeof g.instructions !== 'string' || !g.instructions.trim()) bad('instructions are empty');
  if (!Array.isArray(g.tools)) bad('tools must be a list');
  for (const t of g.tools as string[]) if (!tools.includes(t)) bad(`unknown tool "${t}"`);
  if (!g.workflow || !SHAPES.includes(g.workflow.shape ?? '')) bad('workflow shape');
  if (g.workflow!.shape === 'vote') {
    if (g.workflow!.n === undefined) bad('a vote needs n');
    if (!Number.isInteger(g.workflow!.n) || g.workflow!.n! < 2 || g.workflow!.n! > 7) bad('n must be 2 to 7');
  }
  if (!g.memory || !Number.isInteger(g.memory.examples) || g.memory.examples! < 0 || g.memory.examples! > 8) {
    bad('examples must be 0 to 8');
  }
}
const TOOLS = ['read', 'edit', 'write', 'glob', 'grep', 'run'];

test('seedFirms is idempotent and allocates five firm slots after existing repo slots', () => {
  storeRepo('connor/one', 0);
  storeRepo('connor/two', 1);
  storeRepo('connor/three', 2);
  seedFirms(INSTALLED);
  seedFirms(INSTALLED);
  const firms = listFirms();
  assert.deepEqual(
    firms.map((f) => f.id),
    ['ashlar-vane', 'quickset', 'meridian', 'kiln', 'sparrow'],
  );
  assert.deepEqual(
    firms.map((f) => f.slot),
    [3, 4, 5, 6, 7],
  );
  assert.equal(listAgents().length, 10);
  assert.equal(firm('ashlar-vane')?.name, 'Ashlar & Vane');
  assert.equal(firm('ashlar-vane')?.root, 'gothic');
  assert.equal(firm('quickset')?.root, 'chicago');
  assert.equal(firm('meridian')?.root, 'beauxarts');
  assert.equal(firm('kiln')?.root, 'roman');
  assert.equal(firm('sparrow')?.root, 'pagoda');
  assert.ok(firms.every((f) => f.balance === 300 && f.status === 'active'));
});

test('seedFirms records firm.seeded and agent.seeded once each', () => {
  seedFirms(INSTALLED);
  seedFirms(INSTALLED);
  const log = entries();
  const firmRows = log.filter((e) => e.kind === 'firm.seeded');
  const agentRows = log.filter((e) => e.kind === 'agent.seeded');
  assert.equal(firmRows.length, 5);
  assert.equal(agentRows.length, 10);
  for (const row of firmRows) {
    const f = (row.data as { firm: { id: string } }).firm;
    assert.deepEqual(row.data, { firm: firm(f.id) });
  }
  for (const row of agentRows) {
    const a = (row.data as { agent: Agent }).agent;
    assert.deepEqual(row.data, { agent: agent(a.id) });
  }
});

test('seeded firms carry the agents, models, shapes and silhouettes of the brief', () => {
  seedFirms(INSTALLED);
  const byName = new Map(listAgents().map((a) => [a.name, a]));
  const expect: Array<[string, string, string, string, string]> = [
    ['Ines Ashlar', 'ashlar-vane', 'claude:sonnet', 'self-check', 'lens'],
    ['Teodor Vane', 'ashlar-vane', 'claude:sonnet', 'self-check', 'lens'],
    ['Mack Quickset', 'quickset', 'claude:haiku', 'single', 'cantilever'],
    ['Priya Rao', 'quickset', 'claude:haiku', 'single', 'cantilever'],
    ['Ola Bergstrom', 'quickset', 'claude:sonnet', 'single', 'cantilever'],
    ['Hal Meridian', 'meridian', 'claude:opus', 'plan-then-answer', 'needle'],
    ['Oskar Kiln', 'kiln', 'ollama:qwen3-coder:30b-a3b-q4_K_M', 'plan-then-answer', 'plain'],
    ['Bruno Kiln', 'kiln', 'ollama:gpt-oss:20b', 'plan-then-answer', 'plain'],
    ['Wren Sparrow', 'sparrow', 'ollama:qwen2.5-coder:7b', 'vote', 'plain'],
    ['Juno Pike', 'sparrow', 'ollama:qwen3:1.7b', 'vote', 'plain'],
  ];
  for (const [name, firmId, model, shape, silhouette] of expect) {
    const a = byName.get(name);
    assert.ok(a, `${name} is seeded`);
    assert.equal(a.firmId, firmId, name);
    assert.equal(a.model, model, name);
    assert.equal(a.workflow.shape, shape, name);
    assert.equal(a.silhouette, silhouette, name);
    assert.equal(a.retired, false, name);
    assert.deepEqual(a.tools, TOOLS, name);
    assert.ok(a.instructions.length > 400, `${name} has a persona body`);
  }
  assert.equal(byName.get('Wren Sparrow')!.workflow.n, 3);
  assert.deepEqual(byName.get('Hal Meridian')!.bidsOn, ['high']);
  // Every persona reads as its own person: no two bodies alike.
  const bodies = new Set(listAgents().map((a) => a.instructions));
  assert.equal(bodies.size, 10);
});

test('agents whose model is not installed seed as retired', () => {
  seedFirms([]);
  for (const a of listAgents()) {
    if (a.model.startsWith('ollama:')) {
      assert.equal(a.retired, true, a.name);
      assert.equal(a.retiredReason, 'model not installed', a.name);
    } else {
      assert.equal(a.retired, false, a.name);
      assert.equal(a.retiredReason, null, a.name);
    }
  }
  // A firm with no installed model keeps its plot but stands no towers.
  const kiln = quarters().find((q) => q.firmId === 'kiln');
  assert.ok(kiln);
  assert.equal(kiln.towers.length, 0);
});

test('resolveModel picks the installed tag', () => {
  assert.equal(resolveModel('qwen3-coder:30b-a3b', INSTALLED), 'qwen3-coder:30b-a3b-q4_K_M');
  assert.equal(resolveModel('gpt-oss:20b', INSTALLED), 'gpt-oss:20b');
  assert.equal(resolveModel('qwen3:1.7b', INSTALLED), 'qwen3:1.7b');
  assert.equal(resolveModel('qwen2.5-coder:7b', ['qwen2.5vl:7b']), null);
  assert.equal(resolveModel('qwen3-coder:30b-a3b', []), null);
});

test('installedModels reads ollama list through the runner and is empty when Ollama is not running', async () => {
  const calls: string[][] = [];
  setRunner(async (cmd, args) => {
    calls.push([cmd, ...args]);
    return {
      stdout:
        'NAME                          ID              SIZE      MODIFIED\n' +
        'qwen3-coder:30b-a3b-q4_K_M    06c1097efce0    18 GB     3 weeks ago\n' +
        'gpt-oss:20b                   aa4295ac10c3    13 GB     2 months ago\n',
      stderr: '',
      code: 0,
    };
  });
  assert.deepEqual(await installedModels(), ['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b']);
  assert.deepEqual(calls, [['ollama', 'list']]);

  setRunner(async () => {
    throw new Error('spawn ollama ENOENT');
  });
  assert.deepEqual(await installedModels(), []);
  setRunner(async () => ({ stdout: '', stderr: 'could not connect to ollama app', code: 1 }));
  assert.deepEqual(await installedModels(), []);
});

test("every agent's genome passes a copy of Beagle's validate rules", () => {
  seedFirms(INSTALLED);
  const everyone: Agent[] = [...listAgents()];
  for (let i = 0; i < ROSTER.length; i++) {
    const firmId = SEED_FIRMS[i % SEED_FIRMS.length].firm.id;
    const hired = hire(firmId);
    if (hired) everyone.push(hired);
  }
  assert.ok(everyone.length >= 14);
  for (const a of everyone) {
    const g = toGenome(a);
    assert.doesNotThrow(() => beagleValidate(g, TOOLS), a.name);
    assert.equal(g.id, a.id);
    assert.equal(g.instructions, a.instructions);
  }
  // An Anthropic API agent maps to claude: with a note.
  const api: Agent = { ...everyone[0], model: 'anthropic:claude-sonnet-4-5' };
  const g = toGenome(api);
  assert.equal(g.model, 'claude:claude-sonnet-4-5');
  assert.match(g.note ?? '', /anthropic/i);
  assert.doesNotThrow(() => beagleValidate(g, TOOLS));
});

test('seeded agents carry seeded lineage', () => {
  seedFirms(INSTALLED);
  for (const a of listAgents()) {
    assert.equal(a.lineage.origin, 'seeded');
    assert.deepEqual(a.lineage.parents, []);
    assert.equal(a.lineage.generation, 0);
    assert.ok(Number.isFinite(Date.parse(a.lineage.at)));
    assert.ok(a.memory.examples >= 0 && a.memory.examples <= 8);
  }
});

test('quarters carry one agent tower per active agent with the firm root and silhouette', () => {
  seedFirms(INSTALLED.filter((m) => m !== 'qwen3:1.7b'));
  const floor: Floor = {
    id: 'job-1-agent',
    repo: 'connor/one',
    kind: 'pr',
    refs: ['#4'],
    title: 'Fix the empty state',
    at: '2026-11-10T10:00:00.000Z',
    era: 'glass',
    size: 'small',
    lines: 40,
    claude: true,
    founding: false,
    url: null,
  };
  layEarnedFloor('agent:ines-ashlar', floor);
  const qs = quarters();
  assert.equal(qs.length, 5);
  const counts = Object.fromEntries(qs.map((q) => [q.firmId, q.towers.length]));
  assert.deepEqual(counts, { 'ashlar-vane': 2, quickset: 3, meridian: 1, kiln: 2, sparrow: 1 });
  for (const q of qs) {
    const f = firm(q.firmId)!;
    assert.equal(q.slot, f.slot);
    assert.equal(q.root, f.root);
    assert.equal(q.dark, false);
    for (const t of q.towers) {
      const a = agent(t.agentId!)!;
      assert.equal(t.kind, 'agent');
      assert.equal(t.firmId, q.firmId);
      assert.equal(t.root, f.root);
      assert.equal(t.silhouette, a.silhouette);
      assert.equal(t.datumIndex, 0);
      assert.equal(a.retired, false);
    }
  }
  const ines = qs.find((q) => q.firmId === 'ashlar-vane')!.towers.find((t) => t.agentId === 'ines-ashlar')!;
  assert.equal(ines.floors.length, 1);
  assert.equal(ines.floors[0].title, 'Fix the empty state');
});

test('hire adds a roster agent with roster lineage and refuses a fifth tower', () => {
  seedFirms(INSTALLED);
  // Quickset stands three towers; one hire fills the fourth plot.
  const first = hire('quickset');
  assert.ok(first);
  assert.equal(first.lineage.origin, 'roster');
  assert.equal(first.firmId, 'quickset');
  assert.equal(first.silhouette, 'needle');
  assert.equal(first.towerIndex, 3);
  assert.ok(ROSTER.some((r) => r.name === first.name));
  assert.equal(hire('quickset'), null, 'a fifth tower is refused');
  const hiredRows = entries().filter((e) => e.kind === 'agent.hired');
  assert.equal(hiredRows.length, 1);
  assert.deepEqual(hiredRows[0].data, { agent: agent(first.id) });
  // The same specialist is never hired twice.
  const second = hire('meridian');
  assert.ok(second);
  assert.notEqual(second.name, first.name);
  assert.equal(quarters().find((q) => q.firmId === 'quickset')!.towers.length, 4);
});

test('retiring frees the plot; a bankrupt firm goes dark and a sold tower is re-clad by its buyer', () => {
  seedFirms(INSTALLED);
  retireAgent('priya-rao', 'left the firm');
  assert.equal(agent('priya-rao')!.retired, true);
  assert.equal(agent('priya-rao')!.retiredReason, 'left the firm');
  assert.equal(quarters().find((q) => q.firmId === 'quickset')!.towers.length, 2);
  assert.ok(entries().some((e) => e.kind === 'agent.retired'));
  assert.ok(!idleAgents('quickset').some((a) => a.id === 'priya-rao'));

  retireFirm('sparrow');
  assert.equal(firm('sparrow')!.status, 'bankrupt');
  const dark = quarters().find((q) => q.firmId === 'sparrow')!;
  assert.equal(dark.dark, true);
  assert.equal(dark.towers.length, 2);
  assert.ok(dark.towers.every((t) => t.dark === true));
  assert.ok(listAgents('sparrow').every((a) => a.retired));

  sellTower('wren-sparrow', 'quickset');
  const after = quarters().find((q) => q.firmId === 'sparrow')!;
  const sold = after.towers.find((t) => t.agentId === 'wren-sparrow')!;
  assert.equal(sold.dark, false);
  assert.equal(sold.firmId, 'quickset');
  assert.equal(sold.root, 'chicago');
  assert.ok(entries().some((e) => e.kind === 'tower.sold'));
});

test('idle agents are the active agents of a firm with no live run', () => {
  seedFirms(INSTALLED);
  assert.deepEqual(
    idleAgents('ashlar-vane').map((a) => a.id),
    ['ines-ashlar', 'teodor-vane'],
  );
  openDb()
    .prepare('INSERT INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)')
    .run('run-1', 'job-1', 'connor/one', 'working', JSON.stringify({ id: 'run-1', agentId: 'ines-ashlar', stage: 'working' }));
  assert.deepEqual(
    idleAgents('ashlar-vane').map((a) => a.id),
    ['teodor-vane'],
  );
});

test('startServer does not seed firms', async () => {
  setRunner(async (cmd, args) => {
    if (cmd === 'ollama' || args.includes('ollama')) throw new Error('startServer must never call ollama');
    throw new Error(`unexpected command ${cmd}`);
  });
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(settingsPath, '{}');
  const server = await startServer({ port: 0, claudeSettingsPath: settingsPath });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/city`);
    assert.equal(res.status, 200);
    assert.equal(listFirms().length, 0);
    assert.ok(!entries().some((e) => e.kind === 'firm.seeded'));
  } finally {
    await server.close();
  }
});
