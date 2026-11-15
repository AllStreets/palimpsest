/**
 * The README's diagrams are drawn from the code's own lists (Phase 5 Task
 * 23): a state, stage, check, net, move, kind or port the code changes
 * shows up here as a failure, not as a diagram that quietly drifted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LEDGER_KINDS } from '../shared/ledger-kinds.js';
import { DEFAULT_PORT } from '../engine/server.js';
import { OLLAMA_PORT } from '../engine/market/sandbox.js';
import { RESERVED_PORTS } from '../engine/market/guard-core.mjs';
import {
  AUTONOMY_CHAIN,
  CHECKS,
  EGRESS_STAGES,
  FLOOR_STATES,
  JOB_STATES,
  LEDGER_AUTONOMY_KINDS,
  NETS,
  REOPEN_NOTES,
  RUN_STAGES,
  egressHosts,
  legalMoves,
  neverList,
} from '../tools/diagrams/data.js';
import { floor } from '../tools/diagrams/floor.js';
import { machine } from '../tools/diagrams/machine.js';
import { sandbox } from '../tools/diagrams/sandbox.js';
import { school } from '../tools/diagrams/school.js';
import type { Diagram } from '../tools/diagrams/sheet.js';
import { labelProblems } from '../tools/diagrams/words.js';

function keysOf(d: Diagram): Set<string> {
  const out = new Set<string>();
  for (const l of d.labels) for (const k of l.keys) out.add(k);
  for (const m of d.svg.matchAll(/data-keys="([^"]+)"/g)) for (const k of m[1].replace(/&gt;/g, '>').split(' ')) out.add(k);
  return out;
}

const all = (): Diagram[] => [machine(), floor(), sandbox(), school()];

test('every run stage, check, job state and net appears in its diagram', () => {
  const f = keysOf(floor());
  for (const s of JOB_STATES) assert.ok(f.has(`job:${s}`), `the floor diagram draws the job state ${s}`);
  for (const s of RUN_STAGES) assert.ok(f.has(`stage:${s}`), `the floor diagram draws the run stage ${s}`);
  for (const c of CHECKS) assert.ok(f.has(`check:${c}`), `the floor diagram draws the check ${c}`);
  for (const s of FLOOR_STATES) assert.ok(f.has(`floor:${s}`), `the floor diagram draws the floor state ${s}`);
  for (const [from, to] of legalMoves()) assert.ok(f.has(`move:${from}>${to}`), `the floor diagram draws the legal move ${from} to ${to}`);
  const moves = new Set(legalMoves().map(([a, b]) => `${a}>${b}`));
  for (const k of Object.keys(REOPEN_NOTES)) assert.ok(moves.has(k), `the note on ${k} names a move the code still has`);
  for (const k of f) if (k.startsWith('move:')) assert.ok(moves.has(k.slice(5)), `the floor diagram draws no move the code lacks (${k})`);

  const n = keysOf(school());
  for (const net of NETS) assert.ok(n.has(`net:${net}`), `the school diagram draws the net ${net}`);
  for (const k of AUTONOMY_CHAIN) assert.ok(n.has(`ledger:${k}`), `the school diagram draws ${k}`);
  for (const k of LEDGER_AUTONOMY_KINDS) assert.ok((AUTONOMY_CHAIN as readonly string[]).includes(k), `the autonomy chain draws the ledger kind ${k}`);
  for (const k of AUTONOMY_CHAIN) assert.ok((LEDGER_KINDS as readonly string[]).includes(k), `${k} is a ledger kind`);

  const s = keysOf(sandbox());
  const hosts = egressHosts();
  for (const st of EGRESS_STAGES) {
    assert.ok(s.has(`egress:${st}`), `the sandbox diagram draws the egress stage ${st}`);
    for (const h of hosts[st]) assert.ok(sandbox().labels.some((l) => l.text === h && l.keys.includes(`egress:${st}`)), `the ${st} stage lists ${h}`);
  }
  assert.deepEqual(hosts.checks, [], 'the checks stage reaches nothing');
  for (const item of neverList()) assert.ok(sandbox().labels.some((l) => l.text === item), `the never list draws "${item}"`);
  for (const p of ['tool', 'cli']) assert.ok(s.has(`profile:${p}`), `the sandbox diagram draws the ${p} profile`);
});

test('the machine diagram\'s ports come from DEFAULT_PORT and the Ollama constant', () => {
  const m = machine();
  const text = m.labels.map((l) => l.text).join('\n');
  assert.ok(text.includes(String(DEFAULT_PORT)), 'the engine port is drawn');
  assert.ok(text.includes(String(OLLAMA_PORT)), 'the Ollama port is drawn');
  assert.ok(keysOf(m).has(`port:${DEFAULT_PORT}`) && keysOf(m).has(`port:${OLLAMA_PORT}`));
  for (const p of RESERVED_PORTS) assert.ok(keysOf(m).has(`refused:${p}`), `the refusal of ${p} is drawn`);
  // Drawn from its inputs, never written in: other ports draw other numbers.
  const other = machine({ enginePort: 5123, ollamaPort: 6123 });
  const otherText = other.labels.map((l) => l.text).join('\n');
  assert.ok(otherText.includes('5123') && otherText.includes('6123'));
  assert.ok(!otherText.includes(String(DEFAULT_PORT)) && !otherText.includes(String(OLLAMA_PORT)), 'no port is written into the drawing');
});

test('no label contains an em dash, a double hyphen or an emoji', () => {
  // The guard: the checker itself catches each.
  assert.ok(labelProblems({ text: 'One — two', kind: 'note', keys: [] }).length > 0);
  assert.ok(labelProblems({ text: 'One -- two', kind: 'note', keys: [] }).length > 0);
  assert.ok(labelProblems({ text: 'Done \u{1F680}', kind: 'note', keys: [] }).length > 0);
  for (const d of all()) {
    assert.ok(d.labels.length > 20, `${d.name} sets its words`);
    for (const l of [...d.labels, { text: d.title, kind: 'title' as const, keys: [] }, { text: d.alt, kind: 'note' as const, keys: [] }]) {
      const bad = labelProblems(l).filter((p) => !p.startsWith('case'));
      assert.deepEqual(bad, [], `${d.name}: "${l.text}"`);
    }
    assert.ok(!/—|--|\p{Extended_Pictographic}/u.test(d.svg.replace(/<[^>]+>/g, ' ')), `${d.name}: the drawn text is clean`);
  }
});

test('every label is sentence case', () => {
  // The guard: the checker refuses title case and shouting.
  assert.ok(labelProblems({ text: 'How A Job Becomes A Floor', kind: 'title', keys: [] }).length > 0);
  assert.ok(labelProblems({ text: 'THE ENGINE', kind: 'head', keys: [] }).length > 0);
  assert.ok(labelProblems({ text: 'the engine', kind: 'head', keys: [] }).length > 0);
  assert.deepEqual(labelProblems({ text: 'The engine talks to Ollama and GitHub', kind: 'note', keys: [] }), []);
  for (const d of all()) {
    for (const l of [...d.labels, { text: d.title, kind: 'title' as const, keys: [] }]) {
      assert.deepEqual(labelProblems(l), [], `${d.name}: "${l.text}"`);
    }
  }
});
