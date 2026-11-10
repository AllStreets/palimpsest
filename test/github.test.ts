import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { realRunner, setRunner } from '../engine/exec.js';
import { addLabel, availableRepos, commentIssue, GhError, issueState, mergedPRs, openIssues, removeLabel } from '../engine/github.js';

afterEach(() => {
  setRunner(realRunner);
});

test('availableRepos maps gh json', async () => {
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.deepEqual(args, [
      'repo',
      'list',
      '--limit',
      '500',
      '--json',
      'nameWithOwner,isPrivate,description,primaryLanguage,defaultBranchRef',
    ]);
    const rows = [
      {
        nameWithOwner: 'acme/widgets',
        isPrivate: true,
        description: 'Widgets for acme',
        primaryLanguage: null,
        defaultBranchRef: null,
      },
      {
        nameWithOwner: 'acme/gadgets',
        isPrivate: false,
        description: null,
        primaryLanguage: { name: 'TypeScript' },
        defaultBranchRef: { name: 'trunk' },
      },
    ];
    return { stdout: JSON.stringify(rows), stderr: '', code: 0 };
  });

  const repos = await availableRepos();

  assert.deepEqual(repos, [
    {
      fullName: 'acme/widgets',
      private: true,
      description: 'Widgets for acme',
      language: null,
      defaultBranch: 'main',
    },
    {
      fullName: 'acme/gadgets',
      private: false,
      description: null,
      language: 'TypeScript',
      defaultBranch: 'trunk',
    },
  ]);
});

// additions/deletions are not requested: GitHub computes them per PR, and on a
// repo with a few hundred merged PRs (AllStreets/ONEXUS-Agents, 312) the
// GraphQL query fails every time with "HTTP 502: 502 Bad Gateway". A PR
// floor's size comes from its merge commit's diff in the mirror instead.
test('mergedPRs asks gh only for what GitHub can list cheaply', async () => {
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.deepEqual(args, [
      'pr',
      'list',
      '-R',
      'acme/widgets',
      '--state',
      'merged',
      '--limit',
      '2000',
      '--json',
      'number,title,mergedAt,mergeCommit,url,headRefName',
    ]);
    const rows = [
      {
        number: 12,
        title: 'Add widget polish',
        mergedAt: '2026-01-02T03:04:05Z',
        mergeCommit: { oid: 'abc123' },
        url: 'https://github.com/acme/widgets/pull/12',
        headRefName: 'feature/polish',
      },
      {
        number: 13,
        title: 'Remove dead code',
        mergedAt: '2026-01-03T03:04:05Z',
        mergeCommit: null,
        url: 'https://github.com/acme/widgets/pull/13',
        headRefName: 'palimpsest/j9',
      },
    ];
    return { stdout: JSON.stringify(rows), stderr: '', code: 0 };
  });

  const prs = await mergedPRs('acme/widgets');

  assert.deepEqual(prs, [
    {
      number: 12,
      title: 'Add widget polish',
      mergedAt: '2026-01-02T03:04:05Z',
      mergeSha: 'abc123',
      url: 'https://github.com/acme/widgets/pull/12',
      headRefName: 'feature/polish',
    },
    {
      number: 13,
      title: 'Remove dead code',
      mergedAt: '2026-01-03T03:04:05Z',
      mergeSha: null,
      url: 'https://github.com/acme/widgets/pull/13',
      headRefName: 'palimpsest/j9',
    },
  ]);
});

test('GhError kind missing when gh is not installed', async () => {
  setRunner(async () => {
    const err = new Error('spawn gh ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    throw err;
  });

  await assert.rejects(availableRepos(), (err) => {
    assert.ok(err instanceof GhError);
    assert.equal(err.kind, 'missing');
    assert.match(err.message, /gh auth login/);
    return true;
  });
});

test('GhError kind auth when gh auth fails', async () => {
  setRunner(async (cmd, args) => {
    if (args[0] === 'auth') {
      return { stdout: '', stderr: 'not logged in', code: 1 };
    }
    return { stdout: '', stderr: 'some repo list failure', code: 1 };
  });

  await assert.rejects(availableRepos(), (err) => {
    assert.ok(err instanceof GhError);
    assert.equal(err.kind, 'auth');
    assert.match(err.message, /gh auth login/);
    return true;
  });
});

test('GhError kind notfound when gh cannot resolve the repo', async () => {
  setRunner(async (cmd, args) => {
    if (args[0] === 'auth') {
      return { stdout: '', stderr: '', code: 0 };
    }
    return {
      stdout: '',
      stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/ghost'. (repository)",
      code: 1,
    };
  });

  await assert.rejects(mergedPRs('acme/ghost'), (err) => {
    assert.ok(err instanceof GhError);
    assert.equal(err.kind, 'notfound');
    return true;
  });
});

test('openIssues asks gh for one label, open issues only, and flattens labels and author', async () => {
  const calls: string[][] = [];
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'gh');
    calls.push(args);
    const rows = [
      {
        number: 7,
        title: 'Fix the header',
        body: 'It wraps.',
        labels: [{ name: 'palimpsest:high' }, { name: 'bug' }],
        url: 'https://github.com/acme/widgets/issues/7',
        author: { login: 'connor' },
        updatedAt: '2026-11-09T10:00:00Z',
      },
    ];
    return { stdout: JSON.stringify(rows), stderr: '', code: 0 };
  });

  const issues = await openIssues('acme/widgets', 'palimpsest:high');

  assert.deepEqual(calls, [
    [
      'issue',
      'list',
      '-R',
      'acme/widgets',
      '--label',
      'palimpsest:high',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,body,labels,url,author,updatedAt',
    ],
  ]);
  assert.deepEqual(issues, [
    {
      number: 7,
      title: 'Fix the header',
      body: 'It wraps.',
      labels: ['palimpsest:high', 'bug'],
      url: 'https://github.com/acme/widgets/issues/7',
      author: 'connor',
      updatedAt: '2026-11-09T10:00:00Z',
    },
  ]);
});

test('issueState reads the state of one issue', async () => {
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'gh');
    assert.deepEqual(args, ['issue', 'view', '12', '-R', 'acme/widgets', '--json', 'state']);
    return { stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '', code: 0 };
  });
  assert.equal(await issueState('acme/widgets', 12), 'CLOSED');
});

test('addLabel, removeLabel and commentIssue go through gh issue edit and gh issue comment', async () => {
  const calls: string[][] = [];
  setRunner(async (_cmd, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', code: 0 };
  });

  await addLabel('acme/widgets', 3, 'palimpsest:done');
  await removeLabel('acme/widgets', 3, 'palimpsest');
  await commentIssue('acme/widgets', 3, 'Merged in https://github.com/acme/widgets/pull/9');

  assert.deepEqual(calls, [
    ['issue', 'edit', '3', '-R', 'acme/widgets', '--add-label', 'palimpsest:done'],
    ['issue', 'edit', '3', '-R', 'acme/widgets', '--remove-label', 'palimpsest'],
    ['issue', 'comment', '3', '-R', 'acme/widgets', '--body', 'Merged in https://github.com/acme/widgets/pull/9'],
  ]);
});
