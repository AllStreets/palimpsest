/**
 * tools/launch.ts prints the launch commands for his word and runs none
 * (Phase 5 Decision 10, rule 18), on fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { firstSentence, launchPlan } from '../tools/launch.js';

const README = `<p align="center"><img src="x.png" alt="logo" /></p>

<!-- a comment -->
# Palimpsest

I work across a lot of repos, and their history is mostly invisible. A commit log is a list.

Second paragraph.
`;
const GOOD_PKG = { dependencies: { three: '^0.187.0' } };
const GOOD_LOCK = { lockfileVersion: 3, packages: { '': {}, 'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz' } } };
const BAD_PKG = { dependencies: { beagle: 'git+file:///Users/someone/beagle.git#76c2cbe' } };
const BAD_LOCK = { lockfileVersion: 3, packages: { '': {}, 'node_modules/beagle': { resolved: 'git+file:///Users/someone/beagle.git#76c2cbe' } } };
const PROFILE = '<img src="https://example.test/profile.avif" alt="the city" />';

const base = { readme: README, profile: PROFILE, social: 'docs/brand/social.png', tmp: '/tmp/x' };

test('while installCheck fails it prints only the problems and no launch command', () => {
  const r = launchPlan({ ...base, pkg: BAD_PKG, lock: BAD_LOCK });
  assert.equal(r.ok, false);
  const text = r.lines.join('\n');
  assert.match(text, /beagle/);
  assert.doesNotMatch(text, /git push|gh release|gh repo|git tag|social|profile/i);
});

test('with the check passing it prints all five steps in order', () => {
  const r = launchPlan({ ...base, pkg: GOOD_PKG, lock: GOOD_LOCK });
  assert.equal(r.ok, true);
  const text = r.lines.join('\n');
  const at = [/^1\. .*push/im, /^2\. .*release/im, /^3\. .*description/im, /^4\. .*social/im, /^5\. .*profile/im].map((re) => text.search(re));
  assert.ok(at.every((n) => n >= 0), `a step is missing: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.match(text, /git push origin main/);
  assert.match(text, /git tag v1\.0\.0/);
  assert.match(text, /gh release create v1\.0\.0 docs\/media\/film\.mp4 --title .* --notes-file /);
  assert.match(text, /gh repo edit AllStreets\/palimpsest --description .* --add-topic tauri .*--homepage 'https:\/\/github\.com\/AllStreets\/palimpsest'/);
  assert.match(text, /docs\/brand\/social\.png/);
  assert.ok(text.includes(PROFILE));
});

test('its copy has no em dash, double hyphen in prose or emoji', () => {
  const r = launchPlan({ ...base, pkg: GOOD_PKG, lock: GOOD_LOCK });
  const prose = r.lines.join('\n').replace(/ --[a-z-]+/g, '');
  assert.doesNotMatch(prose, /—|--|\p{Extended_Pictographic}/u);
});

test('the description comes from the README first sentence', () => {
  assert.equal(firstSentence(README), 'I work across a lot of repos, and their history is mostly invisible.');
  const r = launchPlan({ ...base, readme: 'Tiny tool that does a thing. More.', pkg: GOOD_PKG, lock: GOOD_LOCK });
  assert.ok(r.lines.join('\n').includes("--description 'Tiny tool that does a thing.'"));
});

test('it never imports child_process and never spawns', () => {
  const src = readFileSync(new URL('../tools/launch.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process|\bexecSync\b|\bspawn(Sync)?\b|\bexecFile\b|\bexec\(/);
  assert.doesNotMatch(src, /writeFile|appendFile|mkdir|rmSync|unlink/);
});
