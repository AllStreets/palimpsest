import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { AUDIT_MAX_EVIDENCE, AUDIT_MAX_FINDINGS, AUDIT_READ_CAPS, AUDIT_TEXT_CAPS } from '../shared/market-rules.js';
import type { Audit, Finding, Repo, RepoChecks } from '../shared/types.js';
import { mirrorDir } from '../engine/mirror.js';
import { createRunDir } from '../engine/market/worktree.js';
import {
  AUDIT_LOOP_TOOLS,
  AUDIT_SCHEMA,
  AUDIT_TOOLS,
  auditPrompt,
  auditSlug,
  cloneClean,
  countVerdicts,
  parseAudit,
  renderAudit,
  verifyEvidence,
} from '../engine/audit/schema.js';

let tempDir: string;
let previousHome: string | undefined;

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const repo = { fullName: 'acme/widgets', defaultBranch: 'main' } as Repo;
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-audit-schema-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  // A working repo with a 10 line file, a README, a tree and a symlink, then its bare mirror.
  const work = join(tempDir, 'work');
  mkdirSync(join(work, 'src'), { recursive: true });
  gitIn(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# Widgets\n\nSupports hot reload.\n');
  writeFileSync(join(work, 'src', 'ten.ts'), TEN_LINES);
  symlinkSync('README.md', join(work, 'link.md'));
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-q', '-m', 'first');
  gitIn(tempDir, 'clone', '-q', '--bare', work, mirrorDir(repo.fullName));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

/** A clone of the mirror as the audit runner makes it, with one file the agent wrote. */
async function cloneWithAWrite() {
  const made = await createRunDir(repo, 'aud1', 'palimpsest/audit-aud1');
  writeFileSync(join(made.dir, 'src', 'written.ts'), 'export const x = 1;\n');
  return made;
}

const checks: RepoChecks = {
  test: 'npm test',
  typecheck: 'npm run typecheck',
  lint: null,
  build: null,
  screenshot: null,
  preview: null,
  shots: [],
  install: 'npm ci',
  ecosystems: ['npm'],
  detected: true,
};

// ---------------------------------------------------------------- the schema and the prompt

test('the schema allows no unknown keys and names the five verdicts', () => {
  const s = AUDIT_SCHEMA as unknown as { additionalProperties: boolean; required: string[]; properties: { findings: { items: { additionalProperties: boolean; properties: { verdict: { enum: string[] } } } } } };
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['claims', 'findings']);
  assert.equal(s.properties.findings.items.additionalProperties, false);
  assert.deepEqual(s.properties.findings.items.properties.verdict.enum, ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN']);
  assert.deepEqual([...AUDIT_TOOLS], ['Read', 'Glob', 'Grep']);
  assert.deepEqual([...AUDIT_LOOP_TOOLS], ['read_file', 'list_files', 'search', 'run']);
});

test('the prompt names the README path, each docs file, the test command and says the tools cannot write', () => {
  const p = auditPrompt({
    repo,
    readme: { path: 'README.md', text: '# Widgets\n\nSupports hot reload.\n' },
    docs: [
      { path: 'docs/guide.md', text: 'The guide.' },
      { path: 'docs/api.md', text: 'The API.' },
    ],
    checks,
    model: 'claude:sonnet',
  });
  assert.match(p, /README\.md/);
  assert.match(p, /docs\/guide\.md/);
  assert.match(p, /docs\/api\.md/);
  assert.match(p, /npm test/);
  assert.match(p, /npm run typecheck/);
  assert.match(p, /you cannot change files; if a command would, do not run it/i);
  assert.match(p, /Supports hot reload\./);
  assert.match(p, /The guide\./);
  for (const v of ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN']) assert.ok(p.includes(v), v);
  // The Beagle findings are the example of the register.
  assert.match(p, /genome\.ts/);
  assert.doesNotMatch(p, /—|--/);
});

test('the local prompt carries 24 KB of README and the Claude prompt 200 KB', () => {
  const big = 'x'.repeat(2_000_000);
  const base = { repo, readme: { path: 'README.md', text: big }, docs: [{ path: 'docs/a.md', text: 'y'.repeat(50_000) }], checks: null };
  const local = auditPrompt({ ...base, model: 'ollama:qwen2.5-coder:7b' });
  const claude = auditPrompt({ ...base, model: 'claude:sonnet' });
  const longestRun = (s: string, ch: string) => {
    let best = 0;
    let run = 0;
    for (const c of s) {
      run = c === ch ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  };
  assert.equal(longestRun(local, 'x'), AUDIT_READ_CAPS.local, 'the local prompt carries 24 KB of README and not a byte more');
  assert.ok(longestRun(local, 'y') < 10, 'the docs do not fit after the README under the local cap');
  assert.equal(longestRun(claude, 'x'), AUDIT_READ_CAPS.claude, 'the Claude prompt carries 200 KB of README');
  assert.ok(longestRun(claude, 'y') < 10);
  assert.match(local, /docs\/a\.md/);
  assert.ok(local.length < AUDIT_READ_CAPS.local + 20_000, `the local prompt is ${local.length} chars`);
  assert.ok(claude.length < AUDIT_READ_CAPS.claude + 20_000, `the Claude prompt is ${claude.length} chars`);
  assert.match(local, /cut at 24 KB/);
  // No README at all: the prompt says so instead of failing.
  const none = auditPrompt({ repo, readme: null, docs: [], checks: null, model: 'claude:sonnet' });
  assert.match(none, /no README/i);
});

// ---------------------------------------------------------------- parseAudit

function finding(over: Record<string, unknown> = {}) {
  return {
    claim: 'Supports hot reload',
    source: { file: 'README.md', line: 3 },
    verdict: 'MISSING',
    tested: false,
    evidence: [{ file: 'src/ten.ts', line: 2, note: 'no watcher is wired' }],
    proposal: { title: 'Wire hot reload', body: 'Build it.', scope: ['src/**'], acceptance: ['The dev server reloads on save.'], tier: 'high' },
    ...over,
  };
}

test('parseAudit keeps five verdicts, drops unknown keys, caps 60 findings and 3 evidence lines', () => {
  const verdicts = ['REAL', 'PARTIAL', 'MISSING', 'STUBBED', 'BROKEN'];
  const answer = {
    claims: 70,
    extra: 'dropped',
    findings: [
      ...verdicts.map((verdict, i) => finding({ claim: `claim ${i}`, verdict, secret: 'dropped', evidence: Array.from({ length: 5 }, (_, k) => ({ file: 'src/ten.ts', line: k + 1, note: `n${k}`, other: 1 })) })),
      ...Array.from({ length: 70 }, (_, i) => finding({ claim: `more ${i}`, verdict: 'PARTIAL', proposal: null })),
      finding({ claim: 'odd', verdict: 'MAYBE' }),
    ],
  };
  const r = parseAudit(answer, '', repo.fullName);
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.equal(r.claims, 70);
  assert.equal(r.findings.length, AUDIT_MAX_FINDINGS);
  assert.deepEqual(r.findings.slice(0, 5).map((f) => f.verdict), verdicts);
  assert.equal(r.findings[0].id, 'f1');
  assert.equal(r.findings[59].id, 'f60');
  assert.equal(r.findings[0].evidence.length, AUDIT_MAX_EVIDENCE);
  assert.ok(!('secret' in r.findings[0]));
  assert.ok(!('other' in r.findings[0].evidence[0]));
  assert.equal(r.findings[0].evidence[0].verified, false);
  assert.equal(r.findings[0].unverified, false);
  // A REAL claim gets no proposal; a MISSING one keeps its key and tier.
  assert.equal(r.findings[0].proposal, null);
  assert.equal(r.findings[2].proposal?.tier, 'high');
  assert.match(r.findings[2].proposal?.key ?? '', /^acme\/widgets#[0-9a-f]{12}$/);
  assert.equal(r.findings[2].proposal?.jobId, null);
  assert.ok(!r.findings.some((f) => f.claim === 'odd'));
});

test('parseAudit caps the strings, defaults the tier and the acceptance and strips denied scope', () => {
  const r = parseAudit(
    {
      claims: 1,
      findings: [
        finding({
          claim: 'c'.repeat(1000),
          evidence: [{ file: './src//ten.ts', line: 0, note: 'n'.repeat(1000) }],
          proposal: { title: 't'.repeat(500), body: 'b'.repeat(10_000), scope: ['**/.env', '.github/workflows/**', 'src/**', '.claude/x', 'id_rsa'], acceptance: ['', '  '], tier: 'urgent' },
        }),
      ],
    },
    '',
    repo.fullName,
  );
  assert.ok(!('error' in r));
  const f = r.findings[0];
  assert.equal(f.claim.length, AUDIT_TEXT_CAPS.claim);
  assert.equal(f.evidence[0].file, 'src/ten.ts');
  assert.equal(f.evidence[0].line, null);
  assert.equal(f.evidence[0].note.length, AUDIT_TEXT_CAPS.note);
  assert.equal(f.proposal?.title.length, AUDIT_TEXT_CAPS.title);
  assert.equal(f.proposal?.body.length, AUDIT_TEXT_CAPS.body);
  assert.deepEqual(f.proposal?.scope, ['src/**']);
  assert.deepEqual(f.proposal?.acceptance, ['The claim in the README holds and a test shows it.']);
  assert.equal(f.proposal?.tier, 'normal');
});

test('parseAudit refuses absolute, parent, backslash and .git paths without throwing', () => {
  const bad = [`${homedir()}/secret.txt`, '/etc/passwd', '../../.ssh/id_rsa', 'src/../../x.ts', 'src\\ten.ts', '.git/config', 'a/.git/HEAD', '~/x', ''];
  const r = parseAudit(
    {
      claims: 2,
      findings: [
        finding({ evidence: bad.map((file) => ({ file, line: 1, note: 'bad' })) }),
        finding({ claim: 'second', source: { file: '/abs/README.md', line: 1 }, evidence: [{ file: 'src/ten.ts', line: 1, note: 'ok' }, ...bad.map((file) => ({ file, line: 1, note: 'bad' }))] }),
      ],
    },
    '',
    repo.fullName,
  );
  assert.ok(!('error' in r));
  assert.equal(r.findings[0].evidence.length, 0);
  assert.deepEqual(r.findings[1].evidence.map((e) => e.file), ['src/ten.ts']);
  assert.equal(r.findings[1].source.file, '');
  const text = JSON.stringify(r);
  assert.ok(!text.includes(homedir()), 'no path of this Mac');
  assert.ok(!text.includes('..'), 'no parent step');
  assert.ok(!text.includes('\\'), 'no backslash');
});

test('parseAudit falls back to the JSON block in the text', () => {
  const text = `Here is what I found.\n\n{"claims": 2, "findings": [${JSON.stringify(finding())}]}\n\nDone.`;
  const r = parseAudit(null, text, repo.fullName);
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.equal(r.claims, 2);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].claim, 'Supports hot reload');
  // A fenced block with braces in a string still parses.
  const fenced = '```json\n{"claims": 1, "findings": [' + JSON.stringify(finding({ claim: 'has } brace { in it' })) + ']}\n```';
  const r2 = parseAudit(undefined, fenced, repo.fullName);
  assert.ok(!('error' in r2));
  assert.equal(r2.findings[0].claim, 'has } brace { in it');
});

test('a malformed answer returns an error', () => {
  for (const bad of [null, 'nope', 42, { findings: 'no' }, { claims: 1 }, { claims: 1, findings: [{}] }]) {
    const r = parseAudit(bad, 'no json here { not valid', repo.fullName);
    if (bad && typeof bad === 'object' && 'findings' in bad && Array.isArray(bad.findings)) {
      // A finding without a claim is dropped; the answer still parses.
      assert.ok(!('error' in r));
      assert.equal(r.findings.length, 0);
    } else {
      assert.ok('error' in r, JSON.stringify(bad));
      assert.equal(r.error, "the audit's answer did not parse");
    }
  }
});

// ---------------------------------------------------------------- verifyEvidence and cloneClean

function parsed(evidence: Array<{ file: string; line: number | null }>, withProposal = true): Finding {
  const r = parseAudit({ claims: 1, findings: [finding({ evidence: evidence.map((e) => ({ ...e, note: 'n' })), proposal: withProposal ? finding().proposal : null })] }, '', repo.fullName);
  assert.ok(!('error' in r));
  return r.findings[0];
}

test('verifyEvidence marks a file not in the base commit, a symlink, a tree and a line past the end unverified, and a finding with none loses its proposal', async () => {
  const { dir, baseSha } = await cloneWithAWrite();
  const good = parsed([
    { file: 'src/ten.ts', line: 10 },
    { file: 'src/ten.ts', line: 11 },
    { file: 'README.md', line: null },
  ]);
  const written = parsed([{ file: 'src/written.ts', line: 1 }]);
  const link = parsed([{ file: 'link.md', line: 1 }]);
  const tree = parsed([{ file: 'src', line: null }]);
  const missing = parsed([{ file: 'nope.ts', line: null }]);
  const out = await verifyEvidence([good, written, link, tree, missing], dir, baseSha);
  assert.deepEqual(out[0].evidence.map((e) => e.verified), [true, false, true]);
  assert.equal(out[0].unverified, false);
  assert.ok(out[0].proposal, 'a finding with verified evidence keeps its proposal');
  for (const [i, name] of [[1, 'written'], [2, 'symlink'], [3, 'tree'], [4, 'missing']] as const) {
    assert.deepEqual(out[i].evidence.map((e) => e.verified), [false], name);
    assert.equal(out[i].unverified, true, name);
    assert.equal(out[i].proposal, null, name);
  }
  // Nothing in the clone was changed by the check.
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD'), baseSha);
});

test('cloneClean lists the written file', async () => {
  const { dir } = await cloneWithAWrite();
  assert.deepEqual(await cloneClean(dir), ['src/written.ts']);
  rmSync(join(dir, 'src', 'written.ts'));
  assert.deepEqual(await cloneClean(dir), []);
  appendFileSync(join(dir, 'src', 'ten.ts'), 'line 11\n');
  assert.deepEqual(await cloneClean(dir), ['src/ten.ts']);
});

test('an altered .git/config makes cloneClean and verifyEvidence throw "run dir git config changed"', async () => {
  const { dir, baseSha } = await cloneWithAWrite();
  appendFileSync(join(dir, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil\n');
  await assert.rejects(cloneClean(dir), /run dir git config changed/);
  await assert.rejects(verifyEvidence([parsed([{ file: 'src/ten.ts', line: 1 }])], dir, baseSha), /run dir git config changed/);
});

// ---------------------------------------------------------------- the page

function auditOf(findings: Finding[], over: Partial<Audit> = {}): Audit {
  return {
    id: 'aud1',
    repo: repo.fullName,
    model: 'claude:sonnet',
    trigger: 'connect',
    baseSha: 'abc1234',
    status: 'done',
    waitingReason: null,
    startedAt: '2026-11-11T09:00:00.000Z',
    endedAt: '2026-11-11T09:12:00.000Z',
    endedReason: null,
    findings,
    counts: countVerdicts(findings),
    unverified: findings.filter((f) => f.unverified).length,
    claimsRead: findings.length,
    credits: 12,
    unattended: false,
    markdownPath: null,
    ...over,
  };
}

test('countVerdicts counts each verdict', () => {
  const r = parseAudit({ claims: 3, findings: [finding({ verdict: 'REAL' }), finding({ verdict: 'REAL' }), finding({ verdict: 'BROKEN' })] }, '', repo.fullName);
  assert.ok(!('error' in r));
  assert.deepEqual(countVerdicts(r.findings), { REAL: 2, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 1 });
  assert.deepEqual(countVerdicts([]), { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 });
});

test('renderAudit writes the lead, the table and the three sections with no dash punctuation and no path of this Mac', () => {
  const r = parseAudit(
    {
      claims: 4,
      findings: [
        finding({ claim: 'Race engine runs sealed sets', verdict: 'REAL', tested: true, evidence: [{ file: 'test/race.test.ts', line: 12, note: 'the suite covers it' }], proposal: null }),
        finding({ claim: 'Breeding outside geotag -- any arena', verdict: 'BROKEN', tested: true, evidence: [{ file: 'src/genome.ts', line: 40, note: `a hardcoded allow-list rejects coding tools | see ${homedir()}/Downloads/x` }] }),
        finding({ claim: 'Fossils — any domain', verdict: 'PARTIAL', evidence: [{ file: 'src/fossils.ts', line: 3, note: 'an MLP over embeddings, geotag only' }], proposal: { title: 'Generalise fossils', body: 'Make the fossils domain agnostic.', scope: ['src/**'], acceptance: ['A second domain trains.'], tier: 'normal' } }),
        finding({ claim: 'LoRA fine-tuning', verdict: 'MISSING', evidence: [{ file: 'src/train.ts', line: 1, note: 'no LoRA anywhere' }] }),
      ],
    },
    '',
    repo.fullName,
  );
  assert.ok(!('error' in r));
  for (const f of r.findings) for (const e of f.evidence) e.verified = true;
  r.findings[3].unverified = true;
  r.findings[3].proposal = null;
  for (const e of r.findings[3].evidence) e.verified = false;
  const md = renderAudit(auditOf(r.findings), { repoDescription: 'A toy genetic lab' });
  assert.match(md, /^# /m);
  assert.match(md, /Of 4 claims in the README, 1 is real, 1 partial, 1 missing and 1 broken\./);
  assert.match(md, /\| Claim \| Verdict \| Tested \| Evidence \| Proposal \|/);
  assert.match(md, /test\/race\.test\.ts:12/);
  assert.match(md, /src\/genome\.ts:40/);
  assert.match(md, /## Real and tested/);
  assert.match(md, /## Broken or missing/);
  assert.match(md, /## Proposed/);
  assert.match(md, /Generalise fossils/);
  assert.match(md, /Wire hot reload/);
  assert.match(md, /unverified/);
  assert.match(md, /A toy genetic lab/);
  assert.doesNotMatch(md, /—|–|--/);
  assert.ok(!md.includes(homedir()), 'no path of this Mac');
  assert.ok(!md.includes('/Users/'), 'no path of this Mac');

  // An audit with no README.
  const none = renderAudit(auditOf([], { claimsRead: 0 }), { repoDescription: null });
  assert.match(none, /No README to check\./);
  // An audit that failed says so.
  const failed = renderAudit(auditOf([], { status: 'failed', endedReason: 'the audit wrote to its clone' }), { repoDescription: null });
  assert.match(failed, /failed/);
  assert.match(failed, /the audit wrote to its clone/);
});

test('auditSlug is a file name without the slash or anything else', () => {
  assert.equal(auditSlug('acme/widgets', 'aud1'), 'acme-widgets-aud1');
  assert.equal(auditSlug('Acme/My.Repo', '../x y'), 'acme-my-repo-x-y');
});
