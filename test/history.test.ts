import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PR } from '../engine/github.js';
import type { Commit } from '../engine/mirror.js';
import { CLUSTER_GAP_HOURS, CLUSTER_MAX_LINES, ERA_CUTS, foundingFloors, MAX_FOUNDING_FLOORS } from '../engine/history.js';

const REPO = 'AllStreets/palimpsest';
const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:00:00Z');

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function commit(overrides: Partial<Commit> & { sha: string; at: string }): Commit {
  return {
    author: 'Author One',
    subject: 'a commit',
    body: '',
    lines: 1,
    ...overrides,
  };
}

test('constants match the brief', () => {
  assert.equal(MAX_FOUNDING_FLOORS, 120);
  assert.equal(CLUSTER_GAP_HOURS, 6);
  assert.equal(CLUSTER_MAX_LINES, 400);
  assert.deepEqual(ERA_CUTS, [0.2, 0.45, 0.7, 0.9]);
});

test('no commits gives no floors', () => {
  const pr: PR = {
    number: 1,
    title: 'Ignored',
    mergedAt: iso(START),
    lines: 10,
    mergeSha: 'deadbeef',
    url: 'https://github.com/AllStreets/palimpsest/pull/1',
  };

  assert.deepEqual(foundingFloors(REPO, [], []), []);
  // A PR whose mergeSha matches no commit in the list is ignored.
  assert.deepEqual(foundingFloors(REPO, [], [pr]), []);
});

test('PR merge commit becomes a PR floor', () => {
  const mergeCommit = commit({
    sha: 'abc1234def',
    at: iso(START),
    author: 'Author One',
    subject: 'Merge pull request #42',
    body: 'some merge body',
    lines: 3,
  });
  const pr: PR = {
    number: 42,
    title: 'Add the thing',
    mergedAt: iso(START + HOUR),
    lines: 123,
    mergeSha: mergeCommit.sha,
    url: 'https://github.com/AllStreets/palimpsest/pull/42',
  };

  const floors = foundingFloors(REPO, [mergeCommit], [pr]);

  assert.equal(floors.length, 1);
  const floor = floors[0];
  assert.equal(floor.kind, 'pr');
  assert.deepEqual(floor.refs, ['#42']);
  assert.equal(floor.title, 'Add the thing');
  assert.equal(floor.lines, 123);
  assert.equal(floor.url, pr.url);
  assert.equal(floor.at, pr.mergedAt);
  assert.equal(floor.id, `${REPO}#${floor.refs[0]}`);
  assert.equal(floor.founding, true);
  assert.equal(floor.claude, false);
});

test('a PR whose mergeSha matches no commit in the list is ignored', () => {
  const regular = commit({ sha: 'c1', at: iso(START) });
  const pr: PR = {
    number: 7,
    title: 'Merged elsewhere',
    mergedAt: iso(START + HOUR),
    lines: 50,
    mergeSha: 'does-not-exist',
    url: 'https://github.com/AllStreets/palimpsest/pull/7',
  };

  const floors = foundingFloors(REPO, [regular], [pr]);

  assert.equal(floors.length, 1);
  assert.equal(floors[0].kind, 'commits');
});

test('same-author commits within 6h cluster', () => {
  const c1 = commit({ sha: 'aaaaaaa1', at: iso(START), author: 'Author One', subject: 'first', lines: 2 });
  const c2 = commit({ sha: 'bbbbbbb2', at: iso(START + 3 * HOUR), author: 'Author One', subject: 'second', lines: 3 });
  const c3 = commit({ sha: 'ccccccc3', at: iso(START + 5 * HOUR), author: 'Author One', subject: 'third', lines: 4 });

  const floors = foundingFloors(REPO, [c1, c2, c3], []);

  assert.equal(floors.length, 1);
  const floor = floors[0];
  assert.equal(floor.kind, 'commits');
  assert.deepEqual(floor.refs, ['aaaaaaa..ccccccc']);
  assert.equal(floor.title, 'first');
  assert.equal(floor.at, c3.at);
  assert.equal(floor.lines, 9);
});

test('a 7h gap splits clusters', () => {
  const c1 = commit({ sha: 'aaaaaaa1', at: iso(START), author: 'Author One', lines: 2 });
  const c2 = commit({ sha: 'bbbbbbb2', at: iso(START + 7 * HOUR), author: 'Author One', lines: 3 });

  const floors = foundingFloors(REPO, [c1, c2], []);

  assert.equal(floors.length, 2);
  assert.deepEqual(floors[0].refs, ['aaaaaaa']);
  assert.deepEqual(floors[1].refs, ['bbbbbbb']);
});

test('cluster closes at 400 lines', () => {
  const c1 = commit({ sha: 'aaaaaaa1', at: iso(START), author: 'Author One', lines: 300 });
  const c2 = commit({ sha: 'bbbbbbb2', at: iso(START + HOUR), author: 'Author One', lines: 150 });

  const floors = foundingFloors(REPO, [c1, c2], []);

  assert.equal(floors.length, 2);
  assert.equal(floors[0].lines, 300);
  assert.equal(floors[1].lines, 150);
});

test('author change splits clusters', () => {
  const c1 = commit({ sha: 'aaaaaaa1', at: iso(START), author: 'Author One', lines: 2 });
  const c2 = commit({ sha: 'bbbbbbb2', at: iso(START + HOUR), author: 'Author Two', lines: 3 });

  const floors = foundingFloors(REPO, [c1, c2], []);

  assert.equal(floors.length, 2);
  assert.deepEqual(floors[0].refs, ['aaaaaaa']);
  assert.deepEqual(floors[1].refs, ['bbbbbbb']);
});

test('Claude trailer marks the floor', () => {
  const trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

  const plain = commit({ sha: 'aaaaaaa1', at: iso(START), body: 'no trailer here' });
  const [plainFloor] = foundingFloors(REPO, [plain], []);
  assert.equal(plainFloor.claude, false);

  const withTrailer = commit({ sha: 'bbbbbbb2', at: iso(START + 7 * HOUR), body: `body text\n\n${trailer}` });
  const [, trailerFloor] = foundingFloors(REPO, [plain, withTrailer], []);
  assert.equal(trailerFloor.claude, true);

  const mergeCommit = commit({ sha: 'ccccccc3', at: iso(START + 14 * HOUR), body: `merge body\n\n${trailer}` });
  const pr: PR = {
    number: 9,
    title: 'Claude-assisted PR',
    mergedAt: iso(START + 14 * HOUR),
    lines: 20,
    mergeSha: mergeCommit.sha,
    url: 'https://github.com/AllStreets/palimpsest/pull/9',
  };
  const [, , prFloor] = foundingFloors(REPO, [plain, withTrailer, mergeCommit], [pr]);
  assert.equal(prFloor.kind, 'pr');
  assert.equal(prFloor.claude, true);
});

test('caps at 120 floors by merging smallest neighbours', () => {
  const commits: Commit[] = [];
  for (let i = 0; i < 500; i++) {
    commits.push(
      commit({
        sha: `sha${String(i).padStart(4, '0')}`,
        at: iso(START + i * 7 * HOUR),
        author: 'Author One',
        subject: `commit ${i}`,
        lines: 1,
      }),
    );
  }

  const floors = foundingFloors(REPO, commits, []);

  assert.equal(floors.length, 120);
  const totalLines = floors.reduce((sum, floor) => sum + floor.lines, 0);
  assert.equal(totalLines, 500);
});

test('eras follow the timeline', () => {
  const commits: Commit[] = [];
  for (let i = 0; i < 5; i++) {
    commits.push(
      commit({
        sha: `sha${i}`,
        at: iso(START + i * 100 * HOUR),
        author: `Author ${i}`,
        subject: `commit ${i}`,
        lines: 1,
      }),
    );
  }

  const floors = foundingFloors(REPO, commits, []);

  assert.equal(floors.length, 5);
  assert.deepEqual(
    floors.map((floor) => floor.era),
    ['stone', 'brick', 'glass', 'titanium', 'scifi'],
  );
});

test('caps 50,000 commits to 120 floors in under 2 seconds with lines preserved', () => {
  const commits: Commit[] = [];
  for (let i = 0; i < 50_000; i++) {
    commits.push(
      commit({
        sha: `sha${String(i).padStart(6, '0')}`,
        at: iso(START + i * 7 * HOUR),
        author: 'Author One',
        subject: `commit ${i}`,
        lines: 1,
      }),
    );
  }

  const startedAt = Date.now();
  const floors = foundingFloors(REPO, commits, []);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(floors.length, 120);
  const totalLines = floors.reduce((sum, floor) => sum + floor.lines, 0);
  assert.equal(totalLines, 50_000);
  assert.ok(elapsedMs < 2000, `expected under 2000ms, took ${elapsedMs}ms`);
});

test('merging a PR floor with an adjacent commits floor follows the merge rule', () => {
  const claudeTrailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

  // floorA: a large commits floor (lines=1000), never the smallest pair.
  const cA = commit({ sha: 'aaaaaaa1', at: iso(START), author: 'Author A', subject: 'floor A', lines: 1000 });

  // floorPR: a small PR floor (lines=5, no Claude trailer on the merge commit).
  const mergeCommit = commit({
    sha: 'bbbbbbb2',
    at: iso(START + 10 * HOUR),
    author: 'Author B',
    subject: 'merge pr',
    body: 'plain merge, no trailer',
    lines: 1,
  });
  const pr: PR = {
    number: 55,
    title: 'The PR title',
    mergedAt: iso(START + 10 * HOUR),
    lines: 5,
    mergeSha: mergeCommit.sha,
    url: 'https://github.com/AllStreets/palimpsest/pull/55',
  };

  // floorB: a small commits floor (lines=3) with the Claude trailer, so the
  // merge's claude OR must come from this side, not the PR side.
  const cB = commit({
    sha: 'ccccccc3',
    at: iso(START + 20 * HOUR),
    author: 'Author C',
    subject: 'floor B',
    body: `fixed a thing\n\n${claudeTrailer}`,
    lines: 3,
  });

  // 118 more large, well-separated commits floors (lines=1000, combined=2000
  // for every adjacent pair among them) so (floorPR, floorB), combined=8, is
  // unambiguously the smallest pair and the only merge the cap performs
  // (121 floors in, one merge, 120 out).
  const padding: Commit[] = [];
  for (let i = 0; i < 118; i++) {
    padding.push(
      commit({
        sha: `ddddddd${String(i).padStart(3, '0')}`,
        at: iso(START + (30 + i * 10) * HOUR),
        author: 'Author D',
        subject: `padding ${i}`,
        lines: 1000,
      }),
    );
  }

  const floors = foundingFloors(REPO, [cA, mergeCommit, cB, ...padding], [pr]);

  assert.equal(floors.length, 120);

  const merged = floors.find((floor) => floor.refs.length > 1);
  assert.ok(merged, 'expected exactly one merged floor');
  assert.deepEqual(merged!.refs, ['#55', 'ccccccc']);
  assert.equal(merged!.title, 'The PR title'); // title of the earlier (the PR floor)
  assert.equal(merged!.at, cB.at); // at of the later
  assert.equal(merged!.claude, true); // OR: false (PR side) || true (commits side)
  assert.equal(merged!.kind, 'pr'); // 'pr' since either side is
  assert.equal(merged!.url, pr.url); // the PR's url, since the earlier (PR) side is non-null
  assert.equal(merged!.id, `${REPO}#${merged!.refs[0]}`); // id from the first ref
  assert.equal(merged!.lines, 8);
  assert.equal(merged!.size, 'small'); // size recomputed from the combined 8 lines
});
