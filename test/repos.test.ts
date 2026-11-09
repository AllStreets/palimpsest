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
import { analyze, city, connect, disconnect, failInterruptedAnalyses, listRepos, patchRepo, pickRoot } from '../engine/repos.js';
import type { Event } from '../engine/events.js';
import type { District, Repo } from '../shared/types.js';

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

test('legacy repo rows without a slot are backfilled with distinct, finite slots', async () => {
  // Simulates two rows written before Repo gained `slot`: inserted directly
  // into the repos/towers tables, bypassing connect()/saveRepo() entirely,
  // so their JSON genuinely has no `slot` key at all (not merely `undefined`
  // via a typed object, which TypeScript wouldn't let us construct).
  const db = openDb();

  const legacyTower = (repo: string) => ({
    id: `${repo}#founding`,
    repo,
    kind: 'founding',
    root: 'roman',
    floors: [],
    datumIndex: 0,
  });

  const legacyRepo = (fullName: string, connectedAt: string) => ({
    fullName,
    private: false,
    defaultBranch: 'main',
    language: null,
    description: null,
    connected: true,
    pushMode: false,
    root: 'roman',
    // no `slot` key: the exact shape a pre-migration row would have had.
    status: 'ready',
    error: null,
    connectedAt,
    analyzedAt: connectedAt,
  });

  db.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(
    'legacy/one',
    JSON.stringify(legacyRepo('legacy/one', '2026-01-01T00:00:00.000Z')),
  );
  db.prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(
    'legacy/two',
    JSON.stringify(legacyRepo('legacy/two', '2026-01-02T00:00:00.000Z')),
  );
  db.prepare('INSERT INTO towers (repo, json) VALUES (?, ?)').run(
    'legacy/one',
    JSON.stringify(legacyTower('legacy/one')),
  );
  db.prepare('INSERT INTO towers (repo, json) VALUES (?, ?)').run(
    'legacy/two',
    JSON.stringify(legacyTower('legacy/two')),
  );

  // Connecting a brand-new repo must not get stuck computing NaN from the
  // legacy rows' missing slots, and must itself land on a distinct slot.
  setRunner(fixtureRunner('acme/three', []));
  const analyzed = waitForEvent('repo.analyzed');
  await connect('acme/three');
  await analyzed;

  const repos = listRepos();
  assert.equal(repos.length, 3);

  for (const repo of repos) {
    assert.ok(Number.isFinite(repo.slot), `${repo.fullName}'s slot (${repo.slot}) must be finite`);
    assert.ok(Number.isInteger(repo.slot), `${repo.fullName}'s slot (${repo.slot}) must be an integer`);
  }

  const slots = repos.map((r) => r.slot);
  assert.equal(new Set(slots).size, slots.length, 'every slot must be distinct');

  // Backfilled in connectedAt order: legacy/one connected before legacy/two.
  const one = repos.find((r) => r.fullName === 'legacy/one')!;
  const two = repos.find((r) => r.fullName === 'legacy/two')!;
  assert.ok(one.slot < two.slot, 'legacy/one (connected first) must get the earlier slot');

  const districts = city();
  assert.equal(districts.length, 3);
  for (const d of districts) {
    assert.notDeepEqual(d.origin, { x: 0, z: 0 }, `${d.repo}'s district must not sit at the civic plaza`);
  }
});

test('connect, patch and disconnect each emit an event carrying the repo', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName, []));
  const seen: Event[] = [];
  const unsubscribe = subscribe((e) => {
    if (e.type === 'repo.connected' || e.type === 'repo.patched' || e.type === 'repo.disconnected') seen.push(e);
  });

  const analyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await analyzed;
  patchRepo(fullName, { pushMode: true });
  disconnect(fullName);
  unsubscribe();

  assert.deepEqual(
    seen.map((e) => e.type),
    ['repo.connected', 'repo.patched', 'repo.disconnected'],
  );
  for (const e of seen) {
    assert.equal((e.data as { repo: { fullName: string } }).repo.fullName, fullName);
  }
  assert.equal((seen[1].data as { repo: { pushMode: boolean } }).repo.pushMode, true);
  assert.equal((seen[2].data as { repo: { connected: boolean } }).repo.connected, false);
});

test('patching the root restyles the standing tower', async () => {
  const fullName = 'acme/widgets';
  setRunner(
    fixtureRunner(fullName, [
      { sha: 'a1b2c3d', at: '2026-01-01T00:00:00.000Z', author: 'Author One', subject: 'first commit', body: '', lines: 10 },
    ]),
  );
  const analyzed = waitForEvent('repo.analyzed');
  await connect(fullName);
  await analyzed;

  const other = pickRoot(fullName) === 'pagoda' ? 'gothic' : 'pagoda';
  patchRepo(fullName, { root: other });
  assert.equal(city()[0].tower.root, other);
  assert.equal(city()[0].tower.floors.length, 1);
});

/** A Runner whose `gh repo view` waits for `gate`, so a test can act while the first analysis is mid-flight. */
function gatedRunner(fullName: string, gate: Promise<void>) {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      await gate;
      return { stdout: JSON.stringify(repoViewRow(fullName)), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') return { stdout: '', stderr: '', code: 0 };
    if (cmd === 'git' && args.includes('log')) return { stdout: rawLog([]), stderr: '', code: 0 };
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', code: 0 };
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  };
}

test('on, off, on during an analysis ends connected (connect reconnects an analyzing repo)', async () => {
  const fullName = 'acme/widgets';
  let release: () => void = () => {};
  setRunner(gatedRunner(fullName, new Promise<void>((r) => (release = r))));
  const connectedEvents: Event[] = [];
  const unsubscribe = subscribe((e) => {
    if (e.type === 'repo.connected') connectedEvents.push(e);
  });

  await connect(fullName);
  disconnect(fullName);
  const again = await connect(fullName);
  unsubscribe();
  assert.equal(again.connected, true, 'the last connect must not be dropped while the first analysis runs');
  assert.equal(listRepos()[0].connected, true);
  assert.equal(connectedEvents.length, 2, 'the reconnect is announced');

  const analyzed = waitForEvent('repo.analyzed');
  release();
  await analyzed;
  assert.equal(listRepos()[0].connected, true);
  assert.equal(city().length, 1);
});

test('disconnecting during an analysis stays disconnected when the analysis finishes', async () => {
  const fullName = 'acme/widgets';
  let release: () => void = () => {};
  setRunner(gatedRunner(fullName, new Promise<void>((r) => (release = r))));

  await connect(fullName);
  disconnect(fullName);
  const analyzed = waitForEvent('repo.analyzed');
  release();
  const e = await analyzed;
  assert.equal(listRepos()[0].connected, false, 'the finished analysis must not reconnect the repo');
  assert.equal((e.data as { repo: { connected: boolean } }).repo.connected, false);
  assert.deepEqual(city(), []);
});

test('connect refuses a malformed owner/name without storing a row or calling gh', async () => {
  let calls = 0;
  setRunner(async () => {
    calls += 1;
    return { stdout: '', stderr: '', code: 0 };
  });
  for (const name of ['acme', 'acme/widgets/extra', '-acme/widgets', 'acme/-w', 'acme/w x', 'acme/..', 'acme/.', '/widgets', 'acme/']) {
    await assert.rejects(connect(name), /owner\/name/, name);
  }
  assert.deepEqual(listRepos(), []);
  assert.equal(calls, 0);
});

/** A repo row as an engine that died mid-analysis left it: status 'analyzing', with nothing running in this process. */
function storeOrphanedAnalyzing(fullName: string): void {
  const repo: Repo = {
    fullName,
    private: false,
    defaultBranch: 'main',
    language: null,
    description: null,
    connected: true,
    pushMode: false,
    root: pickRoot(fullName),
    slot: 0,
    status: 'analyzing',
    error: null,
    connectedAt: '2026-11-01T10:00:00.000Z',
    analyzedAt: null,
  };
  openDb().prepare('INSERT INTO repos (full_name, json) VALUES (?, ?)').run(fullName, JSON.stringify(repo));
}

test('on start, a repo the last engine left analyzing becomes an error the Repos screen can retry', () => {
  storeOrphanedAnalyzing('acme/widgets');
  storeOrphanedAnalyzing('acme/gadgets');

  failInterruptedAnalyses();

  for (const r of listRepos()) {
    assert.equal(r.status, 'error', r.fullName);
    assert.equal(r.error, 'The engine stopped during analysis. Retry to analyze it again.');
    assert.equal(r.connected, true);
  }
});

test('on start, an analysis running in this process is left alone', async () => {
  const fullName = 'acme/widgets';
  let release: () => void = () => {};
  setRunner(gatedRunner(fullName, new Promise<void>((r) => (release = r))));
  await connect(fullName);

  failInterruptedAnalyses();
  assert.equal(listRepos()[0].status, 'analyzing');

  const analyzed = waitForEvent('repo.analyzed');
  release();
  await analyzed;
  assert.equal(listRepos()[0].status, 'ready');
});

test('connect on a repo left analyzing by a stopped engine starts a fresh analysis', async () => {
  const fullName = 'acme/widgets';
  storeOrphanedAnalyzing(fullName);
  let views = 0;
  const fixture = fixtureRunner(fullName, []);
  setRunner(async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') views += 1;
    return fixture(cmd, args);
  });

  const analyzed = waitForEvent('repo.analyzed');
  const returned = await connect(fullName);
  assert.equal(returned.status, 'analyzing');
  await analyzed;
  assert.equal(views, 1, 'a fresh analysis ran');
  assert.equal(listRepos()[0].status, 'ready');
  assert.equal(city().length, 1);
});

test('overlapping connects and analyze calls on one repo run a single analysis', async () => {
  const fullName = 'acme/widgets';
  let views = 0;
  let release: () => void = () => {};
  const gated = gatedRunner(fullName, new Promise<void>((r) => (release = r)));
  setRunner(async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') views += 1;
    return gated(cmd, args);
  });
  let analyzedEvents = 0;
  const unsubscribe = subscribe((e) => {
    if (e.type === 'repo.analyzed') analyzedEvents += 1;
  });

  await connect(fullName);
  const second = analyze(fullName);
  const third = analyze(fullName);
  await connect(fullName);
  assert.equal(views, 1, 'only the first analysis reached gh');

  release();
  await Promise.all([second, third]);
  await new Promise((r) => setTimeout(r, 20));
  unsubscribe();
  assert.equal(views, 1);
  assert.equal(analyzedEvents, 1);
  assert.equal(listRepos()[0].status, 'ready');

  // Once it has finished, the next connect analyzes afresh.
  const again = waitForEvent('repo.analyzed');
  disconnect(fullName);
  await connect(fullName);
  await again;
  assert.equal(views, 2);
});
