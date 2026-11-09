import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { subscribe } from '../engine/events.js';
import { realRunner, setRunner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { city, connect, disconnect, listRepos, patchRepo, pickRoot } from '../engine/repos.js';
import type { Event } from '../engine/events.js';
import type { District } from '../shared/types.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-repos-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  setRunner(realRunner);
  if (previousHome === undefined) {
    delete process.env.PALIMPSEST_HOME;
  } else {
    process.env.PALIMPSEST_HOME = previousHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Resolves with the first matching event, or rejects if none arrives within timeoutMs. */
function waitForEvent(type: string, timeoutMs = 5000): Promise<Event> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for event '${type}'`));
    }, timeoutMs);
    unsubscribe = subscribe((e) => {
      if (e.type === type) {
        clearTimeout(timer);
        unsubscribe();
        resolve(e);
      }
    });
  });
}

const RS = '\x1e';
const US = '\x1f';

interface FixtureCommit {
  sha: string;
  at: string;
  author: string;
  subject: string;
  body: string;
  lines: number;
}

function rawLog(commits: FixtureCommit[]): string {
  return commits
    .map((c) => `${RS}${c.sha}${US}${c.at}${US}${c.author}${US}${c.subject}${US}${c.body}${US}\n\n${c.lines}\t0\tfile.txt\n`)
    .join('');
}

function repoViewRow(fullName: string, defaultBranch = 'main') {
  return {
    nameWithOwner: fullName,
    isPrivate: false,
    description: 'A fixture repo',
    primaryLanguage: { name: 'TypeScript' },
    defaultBranchRef: { name: defaultBranch },
  };
}

/** A fake Runner serving fixture gh/git output for a single successful analyze() run. */
function fixtureRunner(fullName: string, commits: FixtureCommit[], prJson = '[]') {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify(repoViewRow(fullName)), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('log')) {
      return { stdout: rawLog(commits), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: prJson, stderr: '', code: 0 };
    }
    throw new Error(`fixtureRunner: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

/** Like fixtureRunner, but serves whichever repo name a given call actually asks about, for tests that connect more than one repo under one Runner. */
function multiRepoRunner(commits: FixtureCommit[] = [], prJson = '[]') {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify(repoViewRow(args[2])), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('log')) {
      return { stdout: rawLog(commits), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: prJson, stderr: '', code: 0 };
    }
    throw new Error(`multiRepoRunner: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

function originFor(repo: string, districts: District[]): { x: number; z: number } {
  const district = districts.find((d) => d.repo === repo);
  assert.ok(district, `expected a district for ${repo}`);
  return district!.origin;
}

test('connect returns at once and analysis completes', async () => {
  const fullName = 'acme/widgets';
  setRunner(
    fixtureRunner(fullName, [
      { sha: 'a1b2c3d', at: '2026-01-01T00:00:00.000Z', author: 'Author One', subject: 'first commit', body: '', lines: 10 },
    ]),
  );

  const analyzed = waitForEvent('repo.analyzed');
  const returned = await connect(fullName);

  // connect() returns immediately, before analysis has had a chance to finish.
  assert.equal(returned.status, 'analyzing');
  assert.equal(returned.connected, true);
  assert.equal(returned.root, pickRoot(fullName));

  await analyzed;

  const repos = listRepos();
  assert.equal(repos.length, 1);
  assert.equal(repos[0].fullName, fullName);
  assert.equal(repos[0].status, 'ready');
  assert.equal(repos[0].error, null);
  assert.ok(repos[0].analyzedAt);
  assert.equal(repos[0].language, 'TypeScript');
  assert.equal(repos[0].defaultBranch, 'main');

  const districts = city();
  assert.equal(districts.length, 1);
  assert.equal(districts[0].repo, fullName);
  assert.equal(districts[0].tower.floors.length, 1);
  assert.equal(districts[0].tower.datumIndex, 1);
});

test('empty repo gives a root-only tower', async () => {
  const fullName = 'acme/empty';
  setRunner(fixtureRunner(fullName, []));

  const analyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await analyzed;

  const repos = listRepos();
  assert.equal(repos[0].status, 'ready');

  const districts = city();
  assert.equal(districts[0].tower.floors.length, 0);
});

test('auth failure sets a readable error', async () => {
  const fullName = 'acme/private';
  setRunner(async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: '', stderr: 'permission denied', code: 1 };
    }
    if (cmd === 'gh' && args[0] === 'auth') {
      return { stdout: '', stderr: 'not logged in', code: 1 };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  });

  const errored = waitForEvent('repo.error');
  await connect(fullName);
  await errored;

  const repos = listRepos();
  assert.equal(repos[0].status, 'error');
  assert.match(repos[0].error ?? '', /gh auth login/);
});

test('disconnect keeps the tower and hides the district', async () => {
  const fullName = 'acme/widgets';
  setRunner(
    fixtureRunner(fullName, [
      { sha: 'a1b2c3d', at: '2026-01-01T00:00:00.000Z', author: 'Author One', subject: 'first commit', body: '', lines: 10 },
    ]),
  );

  const analyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await analyzed;

  disconnect(fullName);

  const repos = listRepos();
  assert.equal(repos.length, 1);
  assert.equal(repos[0].connected, false);

  assert.deepEqual(city(), []);

  const db = openDb();
  const row = db.prepare('SELECT json FROM towers WHERE repo = ?').get(fullName) as { json: string } | undefined;
  assert.ok(row, 'tower row should still exist after disconnect');
  assert.equal(JSON.parse(row!.json).floors.length, 1);
});

test('pushMode defaults to false and patches persist', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName, []));

  const analyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await analyzed;

  assert.equal(listRepos()[0].pushMode, false);

  patchRepo(fullName, { pushMode: true });
  assert.equal(listRepos()[0].pushMode, true);

  // Persisted on disk, not just in memory: a fresh connection to the same db sees it too.
  const direct = new DatabaseSync(paths().db);
  const row = direct.prepare('SELECT json FROM repos WHERE full_name = ?').get(fullName) as { json: string };
  assert.equal(JSON.parse(row.json).pushMode, true);
  direct.close();
});

test('pickRoot is stable', () => {
  const a = pickRoot('acme/widgets');
  const b = pickRoot('acme/widgets');
  assert.equal(a, b);

  const styles = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];
  assert.ok(styles.includes(a));
});

test('connect on an already-analyzing repo returns the stored repo and starts no second analysis', async () => {
  const fullName = 'acme/widgets';
  let repoViewCalls = 0;
  let releaseView: () => void = () => {};
  const viewGate = new Promise<void>((resolve) => {
    releaseView = resolve;
  });

  setRunner(async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      repoViewCalls += 1;
      await viewGate; // blocks the first analyze() mid-flight so a second connect() lands while status is still 'analyzing'
      return { stdout: JSON.stringify(repoViewRow(fullName)), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('log')) {
      return { stdout: rawLog([]), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: '[]', stderr: '', code: 0 };
    }
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  });

  const first = await connect(fullName);
  assert.equal(first.status, 'analyzing');

  // The first analysis is still blocked inside repoMeta here.
  const second = await connect(fullName);
  assert.equal(second.status, 'analyzing');
  assert.equal(repoViewCalls, 1, 'connect() while analyzing must not start a second analysis');

  const analyzed = waitForEvent('repo.analyzed');
  releaseView();
  await analyzed;

  assert.equal(repoViewCalls, 1, 'releasing the first analysis must not have triggered a second one');
  assert.equal(listRepos()[0].status, 'ready');
});

test('connect on a disconnected repo sets connected true and re-analyzes', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName, []));

  const firstAnalyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await firstAnalyzed;

  disconnect(fullName);
  assert.equal(listRepos()[0].connected, false);

  const secondAnalyzed = waitForEvent('repo.analyzed');
  const reconnected = await connect(fullName);
  assert.equal(reconnected.connected, true);
  assert.equal(reconnected.status, 'analyzing');

  await secondAnalyzed; // a fresh repo.analyzed event: analysis genuinely re-ran, not a no-op

  assert.equal(listRepos()[0].connected, true);
  assert.equal(listRepos()[0].status, 'ready');
});

test('district origins are stable across a sibling disconnect and reconnect (slot-based)', async () => {
  setRunner(multiRepoRunner());

  for (const name of ['acme/a', 'acme/b', 'acme/c']) {
    const analyzed = waitForEvent('repo.analyzed');
    await connect(name);
    await analyzed;
  }

  const before = city();
  assert.equal(before.length, 3);
  const aOrigin = originFor('acme/a', before);
  const bOrigin = originFor('acme/b', before);
  const cOrigin = originFor('acme/c', before);

  disconnect('acme/b');

  const afterDisconnect = city();
  assert.equal(afterDisconnect.length, 2);
  assert.deepEqual(originFor('acme/a', afterDisconnect), aOrigin, "a's origin must not move when b disconnects");
  assert.deepEqual(originFor('acme/c', afterDisconnect), cOrigin, "c's origin must not move when b disconnects");

  const reanalyzed = waitForEvent('repo.analyzed');
  await connect('acme/b');
  await reanalyzed;

  const afterReconnect = city();
  assert.equal(afterReconnect.length, 3);
  assert.deepEqual(originFor('acme/b', afterReconnect), bOrigin, "b must return to its original origin");
  assert.deepEqual(originFor('acme/a', afterReconnect), aOrigin, "a's origin must not move when b reconnects");
  assert.deepEqual(originFor('acme/c', afterReconnect), cOrigin, "c's origin must not move when b reconnects");
});
