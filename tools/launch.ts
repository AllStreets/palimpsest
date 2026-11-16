/**
 * The launch on GitHub, for his word one step at a time (Phase 5 Decision 10, rule 18):
 *
 *   npm run launch
 *
 * Runs installCheck first; while it names anything, prints only those
 * problems and exits 1. Otherwise prints five numbered steps with the exact
 * commands. It executes nothing and writes nothing: no subprocess, no gh,
 * no git. He runs or approves each step himself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installCheck } from './install-check.js';

const REPO = 'AllStreets/palimpsest';
const TAG = 'v1.0.0';
const TOPICS = ['tauri', 'threejs', 'claude', 'ai-agents', 'macos', 'git-history', 'visualization'];

/** The repository's one-line description on GitHub: a sentence that stands on its own, shown to him at step 3 before anything runs. */
export const DESCRIPTION = 'A Mac app that turns your GitHub repos into a living city, where firms of AI agents bid on your issues and build what passes inspection.';

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface LaunchInput {
  pkg: object;
  lock: object;
  readme: string;
  /** docs/media/profile.md, or null when it is not there yet. */
  profile: string | null;
  /** The social card's path, relative to the repo. */
  social: string;
  /** A temp dir for the release notes. */
  tmp: string;
}

export function launchPlan(i: LaunchInput): { ok: boolean; lines: string[] } {
  const problems = installCheck(i.pkg, i.lock);
  if (problems.length) {
    return {
      ok: false,
      lines: [`${problems.length} local ${problems.length === 1 ? 'dependency' : 'dependencies'} a stranger's clone cannot install:`, ...problems.map((p) => `  ${p}`)],
    };
  }
  const notes = join(i.tmp, 'palimpsest-release-notes.md');
  const description = DESCRIPTION;
  const lines: string[] = [
    'Five steps for your word, one at a time. This prints them and runs none of them.',
    '',
    '1. Push main to GitHub',
    '',
    '  git push origin main',
    '',
    `2. Tag ${TAG} and publish the release with the film`,
    '',
    `  git tag ${TAG}`,
    `  git push origin ${TAG}`,
    `  cat > ${q(notes)} <<'EOF'`,
    'Palimpsest 1.0.',
    '',
    'I built this to see my repos as a city: each repo a district, each merged change a floor.',
    'Firms of AI agents bid on issues, work in a sandbox and open pull requests once they pass inspection.',
    'The film is silent and every frame is the real app on its sample city.',
    'It is a Mac app, and it needs Node 22.13 or later, Rust and a logged in gh.',
    'EOF',
    `  gh release create ${TAG} docs/media/film.mp4 --title 'Palimpsest 1.0' --notes-file ${q(notes)}`,
    '',
    '3. Set the repository description, topics and homepage',
    '',
    `  gh repo edit ${REPO} --description ${q(description)} ${TOPICS.map((t) => `--add-topic ${t}`).join(' ')} --homepage ${q(`https://github.com/${REPO}`)}`,
    '',
    '4. Upload the social preview yourself (this one is manual)',
    '',
    `I cannot upload it. Open github.com/${REPO}/settings, find Social preview, choose Edit, Upload an image, and pick:`,
    '',
    `  ${i.social}`,
    '',
    '5. Add the clip to your profile README (another repo, manual)',
    '',
  ];
  if (i.profile) {
    lines.push('Paste this into the README of your AllStreets/AllStreets repo:', '', ...i.profile.trimEnd().split('\n').map((l) => `  ${l}`));
  } else {
    lines.push('docs/media/profile.md is not in this checkout yet, so there is no snippet to print. Run the film tool first.');
  }
  return { ok: true, lines };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const text = (f: string): string => readFileSync(join(root, f), 'utf8');
  const social = ['docs/media/social.png', 'docs/brand/social.png'].find((f) => existsSync(join(root, f))) ?? 'docs/brand/social.png';
  const profilePath = join(root, 'docs/media/profile.md');
  const { ok, lines } = launchPlan({
    pkg: JSON.parse(text('package.json')) as object,
    lock: JSON.parse(text('package-lock.json')) as object,
    readme: text('README.md'),
    profile: existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null,
    social,
    tmp: process.env.TMPDIR ?? '/tmp',
  });
  (ok ? console.log : console.error)(lines.join('\n'));
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
