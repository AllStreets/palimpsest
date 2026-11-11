/**
 * The detail screens' view logic (Task 37): the run's transcript folded
 * from its log lines, the diff split by file, the issue body as markdown
 * blocks, the award told in prose, the ledger as sentences, the
 * inspection's verdict, and the clean-up every untrusted string passes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanText } from '../app/src/ui/board.js';
import {
  awardRounds,
  cleanLog,
  dayHeading,
  issueBlocks,
  ledgerTrail,
  parseDiff,
  redactDiff,
  redactLog,
  Transcript,
  verdict,
  type Names,
} from '../app/src/ui/detail.js';
import type { Bid, CheckView, InspectionView, LedgerRow, RunLogLine } from '../shared/types.js';

const names: Names = {
  agent: (id) => ({ 'priya-rao': 'Priya Rao', 'ines-ashlar': 'Ines Ashlar', 'bruno-kiln': 'Bruno Kiln', 'wren-sparrow': 'Wren Sparrow', 'corin-hale': 'Corin Hale' })[id] ?? id,
  firm: (id) => ({ quickset: 'Quickset', 'ashlar-vane': 'Ashlar & Vane', kiln: 'Kiln', sparrow: 'Sparrow', lodestar: 'Lodestar' })[id] ?? id,
};

function bid(id: string, firmId: string, agentId: string, price: number, confidence: number, calibrated: number, ev: number): Bid {
  return { id, jobId: 'job-1', firmId, agentId, plan: '', price, confidence, calibrated, appraisal: null, ev, cost: 1, at: '2026-11-10T10:00:00Z' };
}

const line = (kind: RunLogLine['kind'], text: string, data?: unknown): RunLogLine => ({ at: '2026-11-10T10:00:00Z', kind, text, ...(data === undefined ? {} : { data }) });

test('cleanText also takes out the Arabic letter mark, the soft hyphen, the Mongolian vowel separator and the grapheme joiner', () => {
  assert.equal(cleanText('a؜b­c᠎d͏e'), 'abcde');
});

test('a log line loses escapes and hidden characters but keeps its tabs and newlines', () => {
  assert.equal(cleanLog('\u001b[31merror\u001b[0m: ‮gnp.x\u0007'), 'error: gnp.x');
  assert.equal(cleanLog('a\tb\nc\r\nd'), 'a\tb\nc\nd');
  assert.equal(cleanLog(7 as unknown as string), '');
});

test('home folders and tokens never reach the page from a log', () => {
  assert.equal(redactLog('read /Users/connor/.config/gh/hosts.yml'), 'read ~/.config/gh/hosts.yml');
  assert.equal(redactLog('cd /home/ci/work && ls'), 'cd ~/work && ls');
  assert.equal(redactLog('token ghp_abcdefghijklmnopqrstuvwxyz0123 used'), 'token [redacted] used');
  assert.equal(redactLog('key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'), 'key [redacted]');
  assert.equal(redactLog('Authorization: Bearer abc.def-123456789xyz'), 'Authorization: Bearer [redacted]');
  assert.equal(redactLog('github_pat_11ABCDEFG0123456789_abcdefghij'), '[redacted]');
  assert.equal(redactLog('AKIAABCDEFGHIJKLMNOP'), '[redacted]');
  // A commit sha is an identifier, not a secret.
  assert.equal(redactLog('head 8d115eb3819363a9a150adcf9c36ffcbee2579e0'), 'head 8d115eb3819363a9a150adcf9c36ffcbee2579e0');
  // A diff keeps long identifiers in code, losing only homes and known token shapes.
  assert.equal(redactDiff('+const AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef = 1; // /Users/connor/x'), '+const AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef = 1; // ~/x');
  assert.equal(redactDiff('+key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"'), '+key = "[redacted]"');
});

test('the transcript folds each tool call with its results', () => {
  const t = new Transcript();
  const first = t.push([
    line('system', 'claude -p haiku: six tools'),
    line('assistant', 'Reading the README first.'),
    line('tool', 'read_file README.md'),
    line('tool', 'run npm test -- test/schedule'),
    line('tool', 'tests 20, pass 18, fail 2'),
    line('tool', 'not ok 19 dayOf at midnight'),
  ]);
  assert.deepEqual(
    t.entries.map((e) => [e.kind, e.text, e.out.length]),
    [
      ['system', 'claude -p haiku: six tools', 0],
      ['assistant', 'Reading the README first.', 0],
      ['call', 'read_file README.md', 0],
      ['call', 'run npm test -- test/schedule', 2],
    ],
  );
  assert.equal(first.added.length, 4);
  assert.equal(t.lines, 6);
  // A later result joins the call already shown: the change names it as grown, not added.
  const next = t.push([line('tool', 'not ok 20 dayOf across the clock change')]);
  assert.equal(next.added.length, 0);
  assert.deepEqual(next.grown.map((e) => e.index), [3]);
  assert.equal(t.entries[3].out.length, 3);
});

test("claude's tool results find their call by id, and a failed one is marked", () => {
  const t = new Transcript();
  t.push([
    line('tool', 'Read {"file_path":"src/a.ts"}', { id: 'tu_1', name: 'Read' }),
    line('tool', 'Grep {"pattern":"dayOf"}', { id: 'tu_2', name: 'Grep' }),
    line('tool', 'src/a.ts:3: dayOf', { id: 'tu_2', error: false }),
    line('tool', 'file not found', { id: 'tu_1', error: true }),
    line('tool', '$ npm test', { stage: 'working', timeoutMs: 1000 }),
    line('tool', 'ok 1', { stream: 'stdout' }),
  ]);
  assert.deepEqual(
    t.entries.map((e) => [e.kind, e.out.join('|'), e.failed]),
    [
      ['call', 'file not found', true],
      ['call', 'src/a.ts:3: dayOf', false],
      ['call', 'ok 1', false],
    ],
  );
});

test('refusals and egress stand as their own lines with the reason', () => {
  const t = new Transcript();
  t.push([
    line('refused', 'run git push origin HEAD: refused by the guard. A run never pushes; the engine ships from its own clone.'),
    line('egress', 'allowed CONNECT registry.npmjs.org:443 (install)', { allowed: true, host: 'registry.npmjs.org', port: 443, stage: 'install', reason: '' }),
    line('egress', "refused fonts.googleapis.com:443: not on this run's list"),
    line('stderr', 'npm WARN deprecated'),
    line('result', 'success: Done.'),
    line('engine', '[installing] npm ci'),
  ]);
  const [ref, ok, no, err, res, eng] = t.entries;
  assert.equal(ref.kind, 'refused');
  assert.equal(ref.what, 'run git push origin HEAD');
  assert.equal(ref.reason, 'refused by the guard. A run never pushes; the engine ships from its own clone.');
  assert.deepEqual([ok.kind, ok.allowed, ok.what], ['egress', true, 'registry.npmjs.org:443']);
  assert.deepEqual([no.kind, no.allowed, no.what, no.reason], ['egress', false, 'fonts.googleapis.com:443', "not on this run's list"]);
  assert.equal(err.kind, 'stderr');
  assert.equal(res.kind, 'result');
  assert.equal(eng.kind, 'engine');
  assert.equal(t.counts().refused, 2);
});

test('every log line is cleaned and redacted on the way in', () => {
  const t = new Transcript();
  t.push([line('tool', 'read_file /Users/connor/.npmrc'), line('assistant', 'ok‮ done')]);
  assert.equal(t.entries[0].text, 'read_file ~/.npmrc');
  assert.equal(t.entries[1].text, 'ok done');
});

test('a diff splits into files with their hunks and counts', () => {
  const files = parseDiff(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-old',
      '+new',
      '+more',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/old.md b/new.md',
      'similarity index 90%',
      'rename from old.md',
      'rename to new.md',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.from, f.added, f.removed, f.binary]),
    [
      ['src/a.ts', null, 2, 1, false],
      ['img.png', null, 0, 0, true],
      ['new.md', 'old.md', 0, 0, false],
    ],
  );
  assert.deepEqual(
    files[0].lines.map((l) => l.kind),
    ['hunk', 'same', 'del', 'add', 'add'],
  );
  assert.deepEqual(files[0].lines.map((l) => l.text), ['@@ -1,3 +1,4 @@', 'keep', 'old', 'new', 'more']);
  assert.deepEqual([files[0].lines[1].a, files[0].lines[1].b, files[0].lines[3].b, files[0].lines[2].a], [1, 1, 2, 2]);
  assert.deepEqual(parseDiff(''), []);
});

test('the issue body reads as markdown blocks, without the scope and the checklist shown on their own', () => {
  const body = [
    'Ships that arrive between 00:00 and 01:00 UTC show up on the *previous* day. See **this** and `src/schedule/days.ts`.',
    '',
    '## Steps',
    '',
    '1. import [the fixture](https://github.com/tidewater/harbor-ledger/blob/main/f.csv)',
    '2. open [elsewhere](https://evil.example/x)',
    '',
    '```',
    'dayOf(at)',
    '```',
    '',
    '> quoted <img src=x onerror=alert(1)>',
    '',
    'Scope:',
    '- src/schedule/**',
    '- test/schedule/**',
    '',
    '- [ ] Arrivals land in the harbour day',
    '- [x] A test covers it',
  ].join('\n');
  const blocks = issueBlocks(body);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['para', 'heading', 'list', 'code', 'quote'],
  );
  const p = blocks[0];
  assert.ok(p.kind === 'para');
  assert.deepEqual(
    p.inline.map((s) => [s.kind, s.text]),
    [
      ['text', 'Ships that arrive between 00:00 and 01:00 UTC show up on the '],
      ['em', 'previous'],
      ['text', ' day. See '],
      ['strong', 'this'],
      ['text', ' and '],
      ['code', 'src/schedule/days.ts'],
      ['text', '.'],
    ],
  );
  const list = blocks[2];
  assert.ok(list.kind === 'list' && list.ordered);
  const links = list.items.flatMap((i) => i.filter((s) => s.kind === 'link'));
  assert.deepEqual(links.map((s) => [s.text, s.href]), [['the fixture', 'https://github.com/tidewater/harbor-ledger/blob/main/f.csv']]);
  // A link off GitHub stays as its words only.
  assert.ok(list.items[1].some((s) => s.kind === 'text' && s.text.includes('elsewhere')));
  const code = blocks[3];
  assert.ok(code.kind === 'code' && code.text === 'dayOf(at)');
  const quote = blocks[4];
  assert.ok(quote.kind === 'quote' && quote.inline.map((s) => s.text).join('') === 'quoted');
  assert.deepEqual(issueBlocks(''), []);
});

test('the award reads as prose: who won, at what price, the calibrated chance against the stated one, and who came next', () => {
  const winner = bid('b1', 'ashlar-vane', 'ines-ashlar', 38, 0.8, 0.71, 4.6);
  const other = bid('b2', 'quickset', 'priya-rao', 30, 0.7, 0.6, 3.1);
  const ledger: LedgerRow[] = [
    { id: 1, at: '2026-11-10T10:00:00Z', kind: 'bid.placed', data: { bid: other } },
    { id: 2, at: '2026-11-10T10:00:05Z', kind: 'bid.placed', data: { bid: winner } },
    {
      id: 3,
      at: '2026-11-10T10:02:00Z',
      kind: 'job.awarded',
      data: { jobId: 'job-1', considered: [winner, other], chosen: winner, why: 'Chose', satOut: [{ agentId: 'wren-sparrow', reason: 'no slot before the window closed' }] },
    },
  ];
  const [round] = awardRounds(ledger, names, 60);
  assert.equal(round.prose, 'Ashlar & Vane won at 38 credits: calibrated 0.71 against a stated 0.8, an expected value of 4.60 on a 60 credit job. Ines Ashlar does the work. Next best was Quickset at 30 credits (expected value 3.10).');
  assert.deepEqual(round.bids.map((b) => b.id), ['b1', 'b2']);
  assert.deepEqual(round.satOut, [{ agentId: 'wren-sparrow', firmId: null, reason: 'no slot before the window closed' }]);
  // A round that drew nothing says so.
  const [none] = awardRounds([{ id: 9, at: '2026-11-10T11:00:00Z', kind: 'job.awarded', data: { jobId: 'job-1', considered: [], chosen: null, why: 'no bids', satOut: [] } }], names, 60);
  assert.equal(none.prose, 'No firm bid in this round, so the job went back on the board.');
});

test('the ledger trail is a dated list of plain sentences', () => {
  const rows: LedgerRow[] = [
    { id: 1, at: '2026-11-09T22:10:00', kind: 'job.posted', data: { job: { source: 'issue', issue: 214 } } },
    { id: 2, at: '2026-11-09T22:11:00', kind: 'bid.placed', data: { bid: bid('b1', 'quickset', 'priya-rao', 28.31, 0.81, 0.81, 20.29) } },
    { id: 3, at: '2026-11-10T09:00:00', kind: 'run.stage', data: { stage: 'installing' } },
    // Said better by the award and by the job's own move to running: left out.
    { id: 31, at: '2026-11-10T09:00:30', kind: 'job.changed', data: { from: 'bidding', to: 'awarded' } },
    { id: 32, at: '2026-11-10T09:01:00', kind: 'run.stage', data: { stage: 'working' } },
    { id: 4, at: '2026-11-10T09:30:00', kind: 'check.done', data: { check: { name: 'test', status: 'pass' } } },
    { id: 41, at: '2026-11-10T09:30:10', kind: 'check.done', data: { check: { name: 'lint', status: 'pass' } } },
    { id: 42, at: '2026-11-10T09:30:20', kind: 'check.done', data: { check: { name: 'scope', status: 'fail' } } },
    { id: 5, at: '2026-11-10T09:31:00', kind: 'inspection.done', data: { summary: 'Failed: scope, review.' } },
    { id: 51, at: '2026-11-10T09:31:30', kind: 'run.ended', data: { outcome: 'failed', reason: 'The change failed inspection.' } },
    { id: 6, at: '2026-11-10T09:32:00', kind: 'credits.moved', data: { kind: 'pay', to: 'quickset', amount: 66.11 } },
    { id: 7, at: '2026-11-10T09:33:00', kind: 'pr.opened', data: { number: 307 } },
    { id: 8, at: '2026-11-10T09:34:00', kind: 'something.new', data: {} },
  ];
  const days = ledgerTrail(rows, names);
  assert.equal(days.length, 2);
  assert.deepEqual(
    days.flatMap((d) => d.rows.map((r) => r.text)),
    [
      'Posted from issue #214.',
      'Quickset bid 28.31 credits, 81% sure.',
      'The run started installing.',
      'Checks passed: test, lint; failed: scope.',
      'Inspected. Failed: scope, review.',
      'The run failed: the change failed inspection.',
      'Quickset was paid 66.11 credits.',
      'Pull request #307 opened.',
      'something.new',
    ],
  );
  assert.equal(dayHeading('2026-11-10T09:00:00', Date.parse('2026-11-10T15:00:00')), 'Today');
  assert.equal(dayHeading('2026-11-09T09:00:00', Date.parse('2026-11-10T15:00:00')), 'Yesterday');
  assert.equal(dayHeading('2026-11-04T09:00:00', Date.parse('2026-11-10T15:00:00')), 'Wednesday 4 November');
});

test('the verdict line says passed and pushable, or which checks failed', () => {
  const c = (name: CheckView['name'], status: CheckView['status']): CheckView => ({ name, status, detail: '', durationMs: 1, testsRun: null, log: null });
  const base = { id: 'i', runId: 'r', jobId: 'j', repo: 'a/b', reviewerAgentId: null, reviewerFirmId: null, design: null, cost: 0, at: '' } as const;
  const i = (patch: Partial<InspectionView>): InspectionView => ({ ...base, checks: [], passed: false, pushable: false, ...patch });
  assert.equal(verdict(i({ passed: true, pushable: true, checks: [c('test', 'pass')] })).text, 'Passed; pushable');
  assert.equal(verdict(i({ passed: true, pushable: false, checks: [c('test', 'pass')] })).text, 'Passed; opens a pull request, not pushable');
  assert.equal(verdict(i({ checks: [c('test', 'fail'), c('scope', 'fail'), c('lint', 'pass')] })).text, 'Failed: test, scope');
  assert.equal(verdict(i({ inconclusive: 'the diff is too large for any reviewer' })).text, 'Inconclusive: the diff is too large for any reviewer');
  assert.equal(verdict(i({ checks: [c('test', 'pass')] })).text, 'Failed');
});
