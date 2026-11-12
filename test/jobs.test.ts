import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe } from '../engine/events.js';
import { realRunner, setRunner } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import {
  acceptProposed,
  dismissProposed,
  job,
  keyTaken,
  listJobs,
  parseAcceptance,
  parseScope,
  pollJobs,
  postManualJob,
  proposeHarnessJob,
  redact,
  setScope,
  settleJobEffects,
  transition,
} from '../engine/market/jobs.js';
import { HARNESS_KEY, repoMarketDefaults } from '../shared/market-rules.js';
import type { Job, JobStatus, Repo } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-jobs-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  storeRepo();
});

afterEach(async () => {
  await settleJobEffects();
  setRunner(realRunner);
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

const FULL = 'acme/widgets';

function makeRepo(over: Partial<Repo> = {}): Repo {
  return {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: null,
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-11-01T00:00:00.000Z',
    analyzedAt: '2026-11-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function storeRepo(repo: Repo = makeRepo()): Repo {
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

interface FakeIssue {
  number: number;
  title?: string;
  body?: string;
  labels: string[];
}

/**
 * A fake gh: `gh issue list --label L` returns the open issues carrying L
 * (gh's own filter), `gh issue view --json state` answers from `states`, and
 * every write succeeds. Every call is kept in `calls`.
 */
function fakeGh(
  issues: FakeIssue[],
  states: Record<number, 'OPEN' | 'CLOSED'> = {},
  opts: { labels?: string[]; fail?: 'label' | 'comment' } = {},
) {
  const calls: string[][] = [];
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'gh', 'only gh is called');
    calls.push(args);
    if (args[0] === 'auth') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'label' && args[1] === 'list') {
      return { stdout: JSON.stringify((opts.labels ?? []).map((name) => ({ name }))), stderr: '', code: 0 };
    }
    if (opts.fail === 'label' && (args[0] === 'label' || args[1] === 'edit')) {
      return { stdout: '', stderr: 'HTTP 403', code: 1 };
    }
    if (opts.fail === 'comment' && args[1] === 'comment') return { stdout: '', stderr: 'HTTP 403', code: 1 };
    if (args[0] === 'issue' && args[1] === 'list') {
      const label = args[args.indexOf('--label') + 1];
      const rows = issues
        .filter((i) => i.labels.includes(label))
        .map((i) => ({
          number: i.number,
          title: i.title ?? `Issue ${i.number}`,
          body: i.body ?? '',
          labels: i.labels.map((name) => ({ name })),
          url: `https://github.com/${FULL}/issues/${i.number}`,
          author: { login: 'connor' },
          updatedAt: '2026-11-09T00:00:00Z',
        }));
      return { stdout: JSON.stringify(rows), stderr: '', code: 0 };
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      const n = Number(args[2]);
      return { stdout: JSON.stringify({ state: states[n] ?? 'OPEN' }), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
  return calls;
}

function listCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === 'issue' && c[1] === 'list');
}

/** Walks a job through legal moves to `to`. */
function walk(j: Job, path: JobStatus[]): Job {
  let cur = j;
  for (const s of path) cur = transition(cur, s);
  return cur;
}

test('each tier label is queried separately', async () => {
  const calls = fakeGh([]);
  await pollJobs(makeRepo());
  const lists = listCalls(calls);
  assert.equal(lists.length, 3);
  const labels = lists.map((c) => {
    assert.equal(c.filter((a) => a === '--label').length, 1, 'one --label per call');
    return c[c.indexOf('--label') + 1];
  });
  assert.deepEqual(labels.sort(), ['palimpsest', 'palimpsest:high', 'palimpsest:low']);
  for (const c of lists) {
    assert.equal(c[c.indexOf('-R') + 1], FULL);
    assert.equal(c[c.indexOf('--state') + 1], 'open');
  }
});

test('a repo with its own label queries its own three tiers', async () => {
  const calls = fakeGh([]);
  await pollJobs(makeRepo({ label: 'city' }));
  const labels = listCalls(calls).map((c) => c[c.indexOf('--label') + 1]);
  assert.deepEqual(labels.sort(), ['city', 'city:high', 'city:low']);
});

test('an issue labelled only palimpsest:high becomes a high job worth 150', async () => {
  fakeGh([{ number: 4, title: 'Speed up the build', labels: ['palimpsest:high'] }]);
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const posted = await pollJobs(makeRepo());
  off();

  assert.equal(posted.length, 1);
  const j = posted[0];
  assert.equal(j.tier, 'high');
  assert.equal(j.value, 150);
  assert.equal(j.status, 'open');
  assert.equal(j.source, 'issue');
  assert.equal(j.issue, 4);
  assert.equal(j.repo, FULL);
  assert.equal(j.url, `https://github.com/${FULL}/issues/4`);
  assert.equal(j.attempts, 0);
  assert.deepEqual(j.scope, ['**']);
  assert.deepEqual(j.acceptance, ['Speed up the build']);
  assert.deepEqual(job(j.id), j);
  assert.ok(events.includes('job.posted'));
  const rows = entries().filter((e) => e.kind === 'job.posted');
  assert.equal(rows.length, 1);
  assert.deepEqual((rows[0].data as { job: Job }).job, j);
});

test('an issue holding two tier labels takes the highest', async () => {
  fakeGh([
    { number: 1, labels: ['palimpsest', 'palimpsest:low'] },
    { number: 2, labels: ['palimpsest:low', 'palimpsest:high'] },
    { number: 3, labels: ['palimpsest:low'] },
    { number: 5, labels: ['palimpsest'] },
  ]);
  const posted = await pollJobs(makeRepo());
  const byIssue = new Map(posted.map((j) => [j.issue, j]));
  assert.equal(posted.length, 4, 'an issue on two lists is posted once');
  assert.equal(byIssue.get(1)?.tier, 'normal');
  assert.equal(byIssue.get(1)?.value, 60);
  assert.equal(byIssue.get(2)?.tier, 'high');
  assert.equal(byIssue.get(3)?.tier, 'low');
  assert.equal(byIssue.get(3)?.value, 20);
  assert.equal(byIssue.get(5)?.tier, 'normal');
});

test('an issue already holding a job is not posted twice', async () => {
  fakeGh([{ number: 8, labels: ['palimpsest'] }]);
  const first = await pollJobs(makeRepo());
  assert.equal(first.length, 1);
  const second = await pollJobs(makeRepo());
  assert.equal(second.length, 0);
  assert.equal(listJobs({ repo: FULL }).length, 1);

  // Even once that job has ended, the issue does not come back as a new job.
  transition(first[0], 'withdrawn');
  assert.equal((await pollJobs(makeRepo())).length, 0);
  assert.equal(listJobs({ repo: FULL }).length, 1);
});

test('issues marked done or failed are skipped, and so are the city\'s own', async () => {
  fakeGh([
    { number: 1, labels: ['palimpsest', 'palimpsest:done'] },
    { number: 2, labels: ['palimpsest:high', 'palimpsest:failed'] },
    { number: 3, labels: ['palimpsest'], body: 'Opened by the city.\n\n[palimpsest]' },
    { number: 4, labels: ['palimpsest'] },
  ]);
  const posted = await pollJobs(makeRepo());
  assert.deepEqual(
    posted.map((j) => j.issue),
    [4],
  );
});

test('a closed issue withdraws its open job', async () => {
  const issues: FakeIssue[] = [
    { number: 1, labels: ['palimpsest'] },
    { number: 2, labels: ['palimpsest'] },
    { number: 3, labels: ['palimpsest'] },
  ];
  fakeGh(issues);
  const posted = await pollJobs(makeRepo());
  const [j1, j2, j3] = [1, 2, 3].map((n) => posted.find((j) => j.issue === n)!);
  walk(j2, ['bidding', 'awarded', 'running']);

  // Issues 1 and 2 are closed; issue 3 lost its label but is still open.
  const calls = fakeGh([], { 1: 'CLOSED', 2: 'CLOSED', 3: 'OPEN' });
  const killed: string[] = [];
  await pollJobs(makeRepo(), {
    kill: async (id) => {
      killed.push(id);
      transition(job(id)!, 'open');
    },
  });

  assert.equal(job(j1.id)!.status, 'withdrawn');
  assert.ok(job(j1.id)!.closedAt);
  assert.equal(job(j1.id)!.withdrawnBy, 'city', 'a closed issue is withdrawn by the city, explicitly');
  const row = entries().filter((e) => e.kind === 'job.changed' && (e.data as { id: string }).id === j1.id).at(-1)!.data as { by: string };
  assert.equal(row.by, 'city');
  assert.deepEqual(killed, [j2.id], 'the running job is killed first');
  assert.equal(job(j2.id)!.status, 'withdrawn');
  assert.equal(job(j3.id)!.status, 'open', 'an open issue keeps its job');
  const viewed = calls.filter((c) => c[1] === 'view').map((c) => Number(c[2]));
  assert.deepEqual(viewed.sort(), [1, 2, 3]);
  assert.equal(
    calls.filter((c) => c[1] === 'edit' || c[1] === 'comment').length,
    0,
    'reading issues never writes to GitHub',
  );
});

test('a closed issue leaves a waiting job to merge detection', async () => {
  fakeGh([{ number: 6, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting']);
  fakeGh([], { 6: 'CLOSED' });
  await pollJobs(makeRepo());
  assert.equal(job(j.id)!.status, 'waiting');
});

test('a failed listing posts nothing and withdraws nothing', async () => {
  fakeGh([{ number: 1, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  setRunner(async (_cmd, args) => {
    if (args[1] === 'list' && args.includes('palimpsest:low')) return { stdout: '', stderr: 'HTTP 502', code: 1 };
    if (args[0] === 'auth') return { stdout: '', stderr: '', code: 0 };
    if (args[1] === 'view') return { stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '', code: 0 };
    return { stdout: '[]', stderr: '', code: 0 };
  });
  await assert.rejects(pollJobs(makeRepo()));
  assert.equal(job(j.id)!.status, 'open');
});

test('scope and acceptance parse from the body', () => {
  const body = [
    'The header wraps on narrow screens.',
    '',
    'Scope:',
    '- `app/src/ui/**`',
    '- app/index.html',
    '',
    '## Acceptance',
    '- [ ] The header stays on one line at 360 px',
    '- [x] No layout shift on load',
    '* [ ] Tests pass',
  ].join('\n');
  assert.deepEqual(parseScope(body), ['app/src/ui/**', 'app/index.html']);
  assert.deepEqual(parseAcceptance(body, 'Fix the header'), [
    'The header stays on one line at 360 px',
    'No layout shift on load',
    'Tests pass',
  ]);

  assert.deepEqual(parseScope('## Scope\n\nengine/**\ntest/*.ts\n\n## Notes\nnothing'), ['engine/**', 'test/*.ts']);
  assert.deepEqual(parseScope('Scope: engine/**, shared/*.ts'), ['engine/**', 'shared/*.ts']);
  assert.deepEqual(parseScope('No scope here.'), ['**']);
  assert.deepEqual(parseScope('Scope of this is small.\n\n- [ ] Done'), ['**'], 'prose that starts with the word is not a heading');
  assert.deepEqual(parseScope('Scope:\n- `app/**` (the UI only)\n- keep it small'), ['app/**']);
  assert.deepEqual(parseScope(''), ['**']);
  assert.deepEqual(parseAcceptance('Just do it.', 'Rename the thing'), ['Rename the thing']);
});

test('an issue posts with the scope and acceptance its body gives', async () => {
  fakeGh([
    {
      number: 9,
      title: 'Tidy the engine',
      labels: ['palimpsest'],
      body: 'Scope:\n- engine/**\n\n- [ ] Lint is clean',
    },
  ]);
  const [j] = await pollJobs(makeRepo());
  assert.deepEqual(j.scope, ['engine/**']);
  assert.deepEqual(j.acceptance, ['Lint is clean']);
});

test('illegal transitions throw', async () => {
  const j = postManualJob(manualInput());
  const merged = walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
  assert.throws(() => transition(merged, 'open'), /illegal move merged to open/);
  assert.throws(() => transition(j, 'running'), /illegal move merged to running/, 'the stored status is the one checked');
  const fresh = postManualJob(manualInput());
  assert.throws(() => transition(fresh, 'merged'), /illegal move open to merged/);
  assert.equal(job(fresh.id)!.status, 'open', 'a refused move changes nothing');
});

test('bidding returns to open, running goes to failed, halted returns to open', async () => {
  storeRepo();
  const j = postManualJob(manualInput());
  const events: Array<{ type: string; data: unknown }> = [];
  const off = subscribe((e) => events.push(e));

  let cur = transition(j, 'bidding', { bidsCloseAt: '2026-11-09T12:00:00.000Z' });
  assert.equal(cur.bidsCloseAt, '2026-11-09T12:00:00.000Z');
  cur = transition(cur, 'open');
  assert.equal(cur.status, 'open');

  cur = walk(cur, ['bidding', 'awarded', 'running']);
  cur = transition(cur, 'failed');
  assert.equal(cur.status, 'failed');
  assert.equal(cur.attempts, 1, 'a failure consumes an attempt');

  cur = walk(cur, ['open', 'halted']);
  assert.equal(cur.haltedFrom, 'open');
  cur = transition(cur, 'open');
  assert.equal(cur.status, 'open');
  assert.equal(cur.haltedFrom, null);
  off();

  const changed = events.filter((e) => e.type === 'job.changed');
  assert.equal(changed.length, 9);
  const ledger = entries().filter((e) => e.kind === 'job.changed');
  assert.equal(ledger.length, 9);
  assert.deepEqual(
    ledger.map((e) => (e.data as { to: JobStatus }).to),
    ['bidding', 'open', 'bidding', 'awarded', 'running', 'failed', 'open', 'halted', 'open'],
  );
  assert.equal((ledger[0].data as { from: JobStatus }).from, 'open');
});

test('a job halted from waiting resumes to waiting, never to open', async () => {
  const j = postManualJob(manualInput());
  const halted = walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'halted']);
  assert.equal(halted.haltedFrom, 'waiting');
  assert.throws(() => transition(halted, 'open'), /illegal move halted to open/);
  const resumed = transition(halted, 'waiting');
  assert.equal(resumed.status, 'waiting');
  assert.equal(resumed.haltedFrom, null);

  const other = walk(postManualJob(manualInput()), ['halted']);
  assert.throws(() => transition(other, 'waiting'), /illegal move halted to waiting/);
});

test('failed returns to open once then stays failed', async () => {
  const calls = fakeGh([{ number: 11, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());

  let cur = walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'failed']);
  assert.equal(cur.attempts, 1);
  await settleJobEffects();
  assert.equal(calls.filter((c) => c[1] === 'edit').length, 0, 'a first failure leaves the issue alone');

  cur = walk(cur, ['open', 'bidding', 'awarded', 'running', 'failed']);
  assert.equal(cur.attempts, 2);
  assert.throws(() => transition(cur, 'open'), /illegal move failed to open/);
  assert.equal(job(j.id)!.status, 'failed');
  assert.ok(job(j.id)!.closedAt);

  await settleJobEffects();
  assert.deepEqual(
    calls.filter((c) => c[1] === 'edit'),
    [['issue', 'edit', '11', '-R', FULL, '--add-label', 'palimpsest:failed']],
  );
  const comments = calls.filter((c) => c[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0][2], '11');
});

test('the final failure comments the inspection summary', async () => {
  const calls = fakeGh([{ number: 12, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  const once = walk(j, ['bidding', 'awarded', 'running', 'failed', 'open', 'bidding', 'awarded', 'running', 'inspecting']);
  transition(once, 'failed', {}, { summary: 'Tests failed: 3 of 40.' });
  await settleJobEffects();
  const comment = calls.find((c) => c[1] === 'comment')!;
  const body = comment[comment.indexOf('--body') + 1];
  assert.match(body, /Tests failed: 3 of 40\./);
  assert.match(body, /\[palimpsest\]/, 'the city signs its comments');
  assert.doesNotMatch(body, /—|--/);
});

test('a merged issue job gets palimpsest:done and the PR link', async () => {
  const calls = fakeGh([{ number: 13, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  const shipping = walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping']);
  const pr = `https://github.com/${FULL}/pull/21`;
  const merged = transition(shipping, 'merged', {}, { prUrl: pr });
  assert.equal(merged.status, 'merged');
  assert.ok(merged.closedAt);
  await settleJobEffects();
  const creates = calls.filter((c) => c[0] === 'label' && c[1] === 'create');
  assert.equal(creates.length, 1, 'the missing label is created first');
  assert.equal(creates[0][2], 'palimpsest:done');
  assert.ok(
    calls.findIndex((c) => c[0] === 'label' && c[1] === 'create') < calls.findIndex((c) => c[1] === 'edit'),
    'created before it is added',
  );
  assert.deepEqual(
    calls.filter((c) => c[1] === 'edit'),
    [['issue', 'edit', '13', '-R', FULL, '--add-label', 'palimpsest:done']],
  );
  const comment = calls.find((c) => c[1] === 'comment')!;
  assert.ok(comment[comment.indexOf('--body') + 1].includes(pr));
});

test('a manual job merging writes nothing to GitHub', async () => {
  const calls: string[][] = [];
  setRunner(async (_cmd, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', code: 0 };
  });
  const j = postManualJob(manualInput());
  walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
  await settleJobEffects();
  assert.equal(calls.length, 0);
});

function manualInput() {
  return {
    repo: FULL,
    title: 'Add a dark mode toggle',
    body: 'Scope:\n- app/**\n\n- [ ] The toggle remembers its state',
  };
}

test('manual job posts without an issue', () => {
  storeRepo();
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const j = postManualJob({ ...manualInput(), tier: 'high' });
  off();
  assert.equal(j.source, 'manual');
  assert.equal(j.issue, null);
  assert.equal(j.url, null);
  assert.equal(j.status, 'open');
  assert.equal(j.tier, 'high');
  assert.equal(j.value, 150);
  assert.deepEqual(j.scope, ['app/**']);
  assert.deepEqual(j.acceptance, ['The toggle remembers its state']);
  assert.deepEqual(job(j.id), j);
  assert.ok(events.includes('job.posted'));
  assert.equal(entries().filter((e) => e.kind === 'job.posted').length, 1);

  const plain = postManualJob({ repo: FULL, title: 'Rename the config' });
  assert.equal(plain.tier, 'normal');
  assert.equal(plain.value, 60);
  assert.deepEqual(plain.scope, ['**']);
  assert.deepEqual(plain.acceptance, ['Rename the config']);

  assert.throws(() => postManualJob({ repo: 'acme/elsewhere', title: 'x' }), /not connected/);
  assert.throws(() => postManualJob({ repo: FULL, title: '   ' }), /title/);
});

test('the harness proposal waits until accepted and dismiss withdraws it', () => {
  const repo = storeRepo();
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const p = proposeHarnessJob(repo);
  off();
  assert.equal(p.status, 'proposed');
  assert.equal(p.source, 'harness');
  assert.equal(p.title, 'Add a baseline test and build harness');
  assert.equal(p.tier, 'normal');
  assert.equal(p.value, 60);
  assert.deepEqual(p.scope, ['**']);
  assert.ok(events.includes('job.proposed'));
  assert.equal(entries().filter((e) => e.kind === 'job.proposed').length, 1);
  assert.equal(listJobs({ status: 'open' }).length, 0, 'a proposal is not on the open board');

  assert.equal(proposeHarnessJob(repo).id, p.id, 'idempotent per repo');
  assert.equal(entries().filter((e) => e.kind === 'job.proposed').length, 1);

  const accepted = acceptProposed(p.id);
  assert.equal(accepted.status, 'open');
  assert.equal(proposeHarnessJob(repo).id, p.id, 'still one proposal once accepted');
  assert.throws(() => acceptProposed(p.id), /not proposed/);
  assert.throws(() => dismissProposed(p.id), /not proposed/);

  const other = storeRepo(makeRepo({ fullName: 'acme/gadgets', slot: 1 }));
  const q = proposeHarnessJob(other);
  const dismissed = dismissProposed(q.id);
  assert.equal(dismissed.status, 'withdrawn');
  assert.equal(proposeHarnessJob(other).id, q.id, 'a dismissed proposal is not proposed again');
  assert.equal(job(q.id)!.status, 'withdrawn');
});

test('listJobs filters by repo, status and source', () => {
  storeRepo();
  storeRepo(makeRepo({ fullName: 'acme/gadgets', slot: 1 }));
  const a = postManualJob(manualInput());
  const b = postManualJob({ repo: 'acme/gadgets', title: 'Other' });
  transition(b, 'bidding');
  const h = proposeHarnessJob(makeRepo());
  assert.deepEqual(
    listJobs({ repo: FULL }).map((j) => j.id).sort(),
    [a.id, h.id].sort(),
  );
  assert.deepEqual(listJobs({ status: 'bidding' }).map((j) => j.id), [b.id]);
  assert.deepEqual(listJobs({ status: ['open', 'proposed'] }).map((j) => j.id).sort(), [a.id, h.id].sort());
  assert.deepEqual(listJobs({ source: 'harness' }).map((j) => j.id), [h.id]);
  assert.equal(listJobs().length, 3);
  assert.equal(job('nope'), null);
});

test('the final failure creates palimpsest:failed only when the repo lacks it', async () => {
  const calls = fakeGh([{ number: 14, labels: ['palimpsest'] }], {}, { labels: ['palimpsest:failed'] });
  const [j] = await pollJobs(makeRepo());
  walk(j, ['bidding', 'awarded', 'running', 'failed', 'open', 'bidding', 'awarded', 'running', 'failed']);
  await settleJobEffects();
  assert.equal(calls.filter((c) => c[0] === 'label' && c[1] === 'create').length, 0);
  assert.deepEqual(
    calls.filter((c) => c[1] === 'edit'),
    [['issue', 'edit', '14', '-R', FULL, '--add-label', 'palimpsest:failed']],
  );
});

test('a label failure does not stop the comment, nor a comment failure the label', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    let calls = fakeGh([{ number: 15, labels: ['palimpsest'] }], {}, { fail: 'label' });
    const [a] = await pollJobs(makeRepo());
    walk(a, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
    await settleJobEffects();
    assert.equal(calls.filter((c) => c[1] === 'comment').length, 1, 'commented despite the label failure');

    calls = fakeGh([{ number: 16, labels: ['palimpsest'] }], {}, { fail: 'comment' });
    const [b] = await pollJobs(makeRepo());
    walk(b, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
    await settleJobEffects();
    assert.equal(calls.filter((c) => c[1] === 'edit').length, 1, 'labelled despite the comment failure');
  } finally {
    console.warn = warn;
  }
});

test('the write-back refuses the real gh outside the real data home', async () => {
  fakeGh([{ number: 17, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  setRunner(realRunner);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    walk(j, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
    await settleJobEffects();
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /refused/);
  assert.match(warnings[0], /not the real data home/);
});

test('the failure comment is trimmed and keeps tokens and home paths out', async () => {
  const calls = fakeGh([{ number: 18, labels: ['palimpsest'] }]);
  const [j] = await pollJobs(makeRepo());
  const once = walk(j, ['bidding', 'awarded', 'running', 'failed', 'open', 'bidding', 'awarded', 'running', 'inspecting']);
  const home = homedir();
  const summary = [
    `Lint failed in ${home}/Library/Application Support/Palimpsest/runs/r1/repo/src/a.ts and /Users/someone/.config/gh/hosts.yml and ~/.ssh/id_ed25519.`,
    'Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP',
    'x'.repeat(2000),
  ].join(' ');
  transition(once, 'failed', {}, { summary });
  await settleJobEffects();
  const comment = calls.find((c) => c[1] === 'comment')!;
  const body = comment[comment.indexOf('--body') + 1];
  assert.ok(!body.includes(home), 'no path under his home');
  assert.ok(!body.includes('/Users/'));
  assert.ok(!body.includes('~/.ssh'));
  assert.ok(!body.includes('hosts.yml'));
  for (const secret of ['ghp_', 'github_pat_', 'sk-ant-', 'AKIA']) assert.ok(!body.includes(secret), secret);
  assert.match(body, /Lint failed in/);
  assert.ok(body.length < 900, `comment is ${body.length} chars`);
});

// ---------------------------------------------------------------- Phase 3 Task 5: keys, withdrawnBy and scope edits

test('every job carries a key: the harness its HARNESS_KEY, an issue or manual job none', async () => {
  const repo = storeRepo();
  const h = proposeHarnessJob(repo);
  assert.equal(h.key, HARNESS_KEY(repo.fullName));
  assert.equal(h.key, 'acme/widgets#harness');
  assert.equal(keyTaken(repo.fullName, HARNESS_KEY(repo.fullName))?.id, h.id);
  const m = postManualJob({ repo: FULL, title: 'Fix it' });
  assert.equal(m.key, null);
  fakeGh([{ number: 3, labels: ['palimpsest'] }]);
  const [i] = await pollJobs(repo);
  assert.equal(i.key, null);
  const row = openDb().prepare('SELECT key FROM jobs WHERE id = ?').get(h.id) as { key: string | null };
  assert.equal(row.key, h.key, 'the key column is written');
});

test('a merged harness job holds its key, so it is not proposed again; a city withdrawal frees it', () => {
  const repo = storeRepo();
  const h = proposeHarnessJob(repo);
  acceptProposed(h.id);
  walk(job(h.id)!, ['bidding', 'awarded', 'running', 'inspecting', 'shipping', 'merged']);
  assert.equal(proposeHarnessJob(repo).id, h.id, 'a merged harness is not proposed again by itself');
  assert.equal(entries().filter((e) => e.kind === 'job.proposed').length, 1);

  const other = storeRepo(makeRepo({ fullName: 'acme/gadgets', slot: 1 }));
  const q = proposeHarnessJob(other);
  transition(q, 'withdrawn');
  assert.equal(job(q.id)?.withdrawnBy, 'city');
  assert.equal(keyTaken(other.fullName, q.key!), null, 'a city withdrawal frees the key');
  const again = proposeHarnessJob(other);
  assert.notEqual(again.id, q.id);
  assert.equal(again.status, 'proposed');
});

test('a withdrawal notes who made it: him from dismiss, the city otherwise', () => {
  const repo = storeRepo();
  const h = proposeHarnessJob(repo);
  const d = dismissProposed(h.id);
  assert.equal(d.withdrawnBy, 'him');
  const moves = entries().filter((e) => e.kind === 'job.changed' && (e.data as { to: string }).to === 'withdrawn');
  assert.equal((moves.at(-1)!.data as { by: string }).by, 'him');

  const m = postManualJob({ repo: FULL, title: 'Fix it' });
  const w = transition(m, 'withdrawn', {}, { by: 'him' });
  assert.equal(w.withdrawnBy, 'him');
  const m2 = postManualJob({ repo: FULL, title: 'Fix it too' });
  assert.equal(transition(m2, 'withdrawn').withdrawnBy, 'city');
  assert.equal(job(m2.id)?.withdrawnBy, 'city');
  assert.equal(job(m.id)?.withdrawnBy, 'him');
  assert.ok(job(h.id)?.closedAt, 'a withdrawal is final');
  assert.equal(listJobs({ status: 'withdrawn' }).length, 3);
  assert.equal(postManualJob({ repo: FULL, title: 'Stays' }).withdrawnBy, undefined);
});

test('setScope edits a proposed or open job and refuses a denied glob with the reason', () => {
  const repo = storeRepo();
  const h = proposeHarnessJob(repo);
  const events: string[] = [];
  const off = subscribe((e) => events.push(e.type));
  const edited = setScope(h.id, { scope: ['package.json', 'test/**'], acceptance: ['npm test runs the suite'] });
  off();
  assert.deepEqual(edited.scope, ['package.json', 'test/**']);
  assert.deepEqual(edited.acceptance, ['npm test runs the suite']);
  assert.equal(edited.status, 'proposed');
  assert.deepEqual(events, ['job.changed']);
  assert.throws(() => setScope(h.id, { scope: ['.github/workflows/ci.yml'] }), /\.github\/workflows\/\*\*/);
  assert.throws(() => setScope(h.id, { scope: ['src/**', 'id_rsa'] }), /id_rsa/);
  assert.throws(() => setScope(h.id, { scope: ['{.git,src}/**'] }), /refused/, 'braces cannot smuggle a denied folder');
  assert.throws(() => setScope(h.id, { scope: ['[.]git/**'] }), /refused/, 'a class cannot smuggle a denied folder');
  assert.throws(() => setScope(h.id, { scope: ['src/{a,b}/**'] }), /refused/, 'no braces at all');
  assert.deepEqual(job(h.id)?.scope, ['package.json', 'test/**']);
  const m = postManualJob({ repo: FULL, title: 'Fix it' });
  assert.deepEqual(setScope(m.id, { scope: ['src/*.ts'] }).scope, ['src/*.ts']);
  transition(job(m.id)!, 'bidding');
  assert.throws(() => setScope(m.id, { scope: ['src/**'] }), /only while proposed or open/);
});

test('a legacy withdrawn row with no withdrawnBy counts as taken', () => {
  const repo = storeRepo();
  const key = HARNESS_KEY(repo.fullName);
  const legacy = { ...proposeHarnessJob(repo), id: 'job-legacy', status: 'withdrawn', closedAt: '2026-10-02T00:00:00.000Z', postedAt: '2026-10-01T00:00:00.000Z' } as Job;
  delete (legacy as { withdrawnBy?: unknown }).withdrawnBy;
  openDb().prepare('DELETE FROM jobs').run();
  openDb().prepare('INSERT INTO jobs (id, repo, status, json, key) VALUES (?, ?, ?, ?, ?)').run(legacy.id, legacy.repo, legacy.status, JSON.stringify(legacy), key);
  assert.equal(job(legacy.id)?.withdrawnBy, undefined);
  assert.equal(keyTaken(repo.fullName, key)?.id, 'job-legacy');
  assert.equal(proposeHarnessJob(repo).id, 'job-legacy', 'not proposed again');
});

test('redact() pins: a 44 character mixed-case run, sk-ant, ghp_ and github_pat_ go, a 40 hex sha stays', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(redact('k AbCdEf0123456789AbCdEf0123456789AbCdEf012345 z'), 'k [redacted] z');
  assert.equal(redact('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'), '[redacted]');
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), '[redacted]');
  assert.equal(redact('github_pat_11ABCDEFG0abcdefghijklmnopqrstuv'), '[redacted]');
  assert.equal(redact(`at ${sha}`), `at ${sha}`);
});
