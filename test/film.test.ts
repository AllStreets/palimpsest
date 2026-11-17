/**
 * The film and the profile clip (Phase 5 rulings 9 and 10): the cut's plan
 * and the ffmpeg arguments it builds, checked without running ffmpeg.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FADE_SECONDS,
  FILM,
  FILM_PLAN,
  PROFILE,
  TITLE_SECONDS,
  bitrateKbps,
  filmSeconds,
  filmShots,
  loopFilter,
  profileLoopArc,
  passArgs,
  profileSnippet,
  segmentArgs,
  titleFilter,
} from '../tools/film.js';
import { labelProblems } from '../tools/diagrams/words.js';

test('the film runs 70 to 90 seconds in the ruled order', () => {
  const s = filmSeconds(FILM_PLAN);
  assert.ok(s >= 70 && s <= 90, `${s} s`);
  const order = FILM_PLAN.flatMap((x) => ('clip' in x ? [x.clip] : 'still' in x ? [x.still] : []));
  assert.deepEqual(order, ['hero-rise', 'construction', 'ride', 'commute', 'brief', 'audit', 'voyage', 'observatory', 'week', 'flyover']);
  for (const x of FILM_PLAN) if ('still' in x) assert.equal(x.seconds, 4, `${x.still} holds 4 s`);
  assert.equal(TITLE_SECONDS, 2);
  assert.equal(FADE_SECONDS, 0.5);
});

test('each title card is one line in sentence case with no em dash, double hyphen or emoji', () => {
  const titles = FILM_PLAN.flatMap((x) => ('title' in x ? [x.title] : []));
  assert.ok(titles.length >= 5);
  for (const t of titles) {
    assert.ok(!/\n/.test(t), `${t} is one line`);
    assert.deepEqual(labelProblems({ text: t, kind: 'title', keys: [] }), [], t);
  }
});

test('a title fades in and out over its 2 s, on the dusk ink rather than through black', () => {
  assert.equal(titleFilter(), 'fade=t=in:st=0:d=0.5:color=0x0a0b0f,fade=t=out:st=1.5:d=0.5:color=0x0a0b0f,format=yuv420p');
});

test('a clip segment starts at its frame and is cut to its length at 1600 by 1000 and 30 fps', () => {
  const args = segmentArgs({ clip: 'week', from: 2, seconds: 10 }, { dir: '/f/week', fps: 24 }, '/o/s.mp4');
  const s = args.join(' ');
  assert.ok(s.includes('-framerate 24 -start_number 48 -i /f/week/f%04d.png'), s);
  assert.ok(s.includes('-t 10'), s);
  assert.ok(s.includes('fps=30,scale=1600:1000:flags=lanczos,format=yuv420p'), s);
  assert.ok(s.endsWith('/o/s.mp4'), s);
  const still = segmentArgs({ still: 'brief', seconds: 4 }, { dir: '/f/stills', fps: 30 }, '/o/b.mp4').join(' ');
  assert.ok(still.includes('-loop 1 -framerate 30 -i /f/stills/brief.png') && still.includes('-t 4'), still);
});

test('the film is two-pass H.264 yuv420p with +faststart, silent, sized under 9.5 MB', () => {
  assert.deepEqual([FILM.width, FILM.height, FILM.fps], [1600, 1000, 30]);
  assert.equal(FILM.maxBytes, 9.5 * 1024 * 1024);
  const kbps = bitrateKbps(FILM.maxBytes, 87);
  // Bits for the whole film at that rate stay under the cap with room for the container.
  assert.ok((kbps * 1000 * 87) / 8 < FILM.maxBytes * 0.97, `${kbps} kbps`);
  const one = passArgs(1, '/t/cut.mp4', '/o/film.mp4', kbps, '/t/pass').join(' ');
  const two = passArgs(2, '/t/cut.mp4', '/o/film.mp4', kbps, '/t/pass').join(' ');
  for (const s of [one, two]) {
    assert.ok(s.includes('-c:v libx264') && s.includes(`-b:v ${kbps}k`) && s.includes('-pix_fmt yuv420p') && s.includes('-an') && s.includes('-r 30'), s);
    assert.ok(s.includes('-passlogfile /t/pass'), s);
  }
  assert.ok(one.includes('-pass 1') && one.endsWith('-f null /dev/null'), one);
  assert.ok(two.includes('-pass 2') && two.includes('-movflags +faststart') && two.endsWith('/o/film.mp4'), two);
});

test('the profile clip is a 10 to 12 s seamless loop of the flyover at 800 by 500', () => {
  // Its own take of the flyover's arc, there and back, so the camera at the tail stands where it stood at the head.
  assert.equal(PROFILE.clip, 'profile-loop');
  assert.ok(PROFILE.seconds >= 10 && PROFILE.seconds <= 12);
  assert.deepEqual([PROFILE.width, PROFILE.height], [800, 500]);
  assert.equal(PROFILE.maxAvif, 3 * 1024 * 1024);
  assert.equal(PROFILE.maxWebp, 4 * 1024 * 1024);
  // The last second blends into the first: the tail is the head's lead-in, so frame L meets frame 0.
  assert.equal(loopFilter(11, 1), '[0:v]split[a][b];[a]trim=start=1:end=12,setpts=PTS-STARTPTS[main];[b]trim=start=0:end=1,setpts=PTS-STARTPTS[head];[main][head]xfade=transition=fade:duration=1:offset=10,format=yuv420p[out]');
});

test("the profile loop's camera stands at its tail where it stood at its head, at rest at each end of the arc", () => {
  const period = PROFILE.seconds;
  for (const s of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(profileLoopArc(s + period, period) - profileLoopArc(s, period)) < 1e-9, `${s} s`);
  assert.ok(Math.abs(profileLoopArc(0, period) - 0.35) < 1e-9);
  assert.ok(Math.abs(profileLoopArc(period / 2, period) - 1) < 1e-9);
  // At rest where it turns: a frame's step there is far smaller than mid-arc.
  const step = (s: number): number => Math.abs(profileLoopArc(s + 1 / 30, period) - profileLoopArc(s, period));
  assert.ok(step(0) < step(period / 4) / 20 && step(period / 2) < step(period / 4) / 20);
});

test('the profile snippet links the repo with the AVIF and its WebP fallback, alt text in the house style', () => {
  const s = profileSnippet('AllStreets/palimpsest');
  assert.ok(s.includes('srcset="https://raw.githubusercontent.com/AllStreets/palimpsest/main/docs/media/profile.avif"'), s);
  assert.ok(s.includes('src="https://raw.githubusercontent.com/AllStreets/palimpsest/main/docs/media/profile.webp"'), s);
  assert.ok(s.includes('href="https://github.com/AllStreets/palimpsest"'), s);
  const alt = /alt="([^"]+)"/.exec(s)?.[1] ?? '';
  assert.ok(alt.length > 20 && !/—|--/.test(alt), alt);
});

test('the film asks the capture tool for every clip and still it cuts, in an order that leaves the clock for last', () => {
  const shots = filmShots();
  for (const n of ['brief', 'audit-page', 'voyage', 'observatory', 'ride', 'week', 'flyover', 'profile-loop', 'hero-rise', 'construction-clip', 'commute']) assert.ok(shots.includes(n), n);
  // The shots that tick the economy's clock come after the stills that show the board as it stands.
  assert.ok(shots.indexOf('construction-clip') > shots.indexOf('brief') && shots.indexOf('construction-clip') > shots.indexOf('audit-page'));
});

test('capture.ts and film.ts take their output from outDir, listen on 4788 by default and keep no GIF or card outputs', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['capture', 'film']) {
    const src = readFileSync(new URL(`../tools/${f}.ts`, import.meta.url), 'utf8');
    assert.ok(/outDir\(process\.env, 'palimpsest-(capture|film)-'\)/.test(src), `${f} uses outDir`);
    assert.ok(!/process\.env\.CAPTURE_OUT \?\?/.test(src), `${f} does not default to docs/media`);
    assert.ok(/CAPTURE_PORT \?\? '?4788/.test(src), `${f} defaults CAPTURE_PORT to 4788`);
  }
  const capture = readFileSync(new URL('../tools/capture.ts', import.meta.url), 'utf8');
  assert.ok(!/\.gif`|-card\.(avif|webp)`/.test(capture), 'no GIF or card output');
});

test('capturePort defaults to 4788 and refuses a bad value, the engine and the dev server', async () => {
  const { capturePort } = await import('../tools/film.js');
  assert.equal(capturePort(undefined), 4788);
  assert.equal(capturePort('4789'), 4789);
  for (const bad of ['abc', '80', '70000', '4770', '4771']) assert.throws(() => capturePort(bad), /CAPTURE_PORT/, bad);
});

test('capture.ts walks the week its history was seeded in, never the week the run is made in', async () => {
  const { readFileSync } = await import('node:fs');
  const capture = readFileSync(new URL('../tools/capture.ts', import.meta.url), 'utf8');
  // A bare tourStart() names the week of the day the capture runs; from the Monday after the seed that week is empty.
  assert.ok(!/tourStart\(\)/.test(capture), 'no bare tourStart()');
  assert.ok(/tourStart\(\$\{JSON\.stringify\(await seededWeek\(page, seededAt\)\)\}\)/.test(capture), 'the tour starts on the seeded week');
  const uiTest = readFileSync(new URL('../tools/ui-test.ts', import.meta.url), 'utf8');
  assert.ok(!/tourStart\(\)/.test(uiTest), 'ui-test has no bare tourStart()');
  assert.ok(!/fetch\('\/api\/tour'\)/.test(uiTest), 'ui-test plans the seeded week, not the current one');
});

test("a bare capture.ts writes the palette with the README's media", async () => {
  const { readFileSync } = await import('node:fs');
  const capture = readFileSync(new URL('../tools/capture.ts', import.meta.url), 'utf8');
  const shots = /const README_SHOTS = \[([^\]]*)\]/.exec(capture)?.[1] ?? '';
  assert.ok(/'palette'/.test(shots), 'palette is in README_SHOTS');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('docs/media/palette.webp'), 'the README shows palette.webp');
});
