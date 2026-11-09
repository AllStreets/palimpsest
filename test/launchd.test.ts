import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { realRunner, setRunner } from '../engine/exec.js';
import { install, LABEL, plist } from '../engine/launchd.js';

test('plist contains label, KeepAlive and the PATH', () => {
  const xml = plist({
    node: '/usr/local/bin/node',
    repo: '/Users/connorevans/Downloads/palimpsest',
    logs: '/Users/connorevans/Library/Application Support/Palimpsest/logs',
    path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  });

  assert.match(xml, /<key>Label<\/key>\s*<string>com\.palimpsest\.engine<\/string>/);
  assert.equal(LABEL, 'com.palimpsest.engine');

  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);

  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>--import<\/string>/);
  assert.match(xml, /<string>tsx<\/string>/);
  assert.match(xml, /<string>\/Users\/connorevans\/Downloads\/palimpsest\/engine\/main\.ts<\/string>/);

  assert.match(
    xml,
    /<key>WorkingDirectory<\/key>\s*<string>\/Users\/connorevans\/Downloads\/palimpsest<\/string>/,
  );

  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);

  assert.match(
    xml,
    /<key>StandardOutPath<\/key>\s*<string>\/Users\/connorevans\/Library\/Application Support\/Palimpsest\/logs\/engine\.log<\/string>/,
  );
  assert.match(
    xml,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/connorevans\/Library\/Application Support\/Palimpsest\/logs\/engine\.log<\/string>/,
  );
});

test('install waits for a booted-out agent to finish unloading before bootstrapping it again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palimpsest-launchd-test-'));
  const previous = { HOME: process.env.HOME, PALIMPSEST_HOME: process.env.PALIMPSEST_HOME };
  process.env.HOME = dir;
  process.env.PALIMPSEST_HOME = join(dir, 'data');
  t.after(() => {
    setRunner(realRunner);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // launchctl bootout returns before the old agent has finished unloading:
  // the service still prints for a while, and bootstrapping it then fails
  // with "Bootstrap failed: 5: Input/output error" (seen on the real machine).
  let printsUntilGone = 3;
  const calls: string[] = [];
  setRunner(async (cmd, args) => {
    assert.equal(cmd, 'launchctl');
    calls.push(args[0]);
    if (args[0] === 'bootout') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'print') {
      if (printsUntilGone > 0) {
        printsUntilGone -= 1;
        return { stdout: 'state = running', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'Could not find service', code: 113 };
    }
    if (args[0] === 'bootstrap') {
      return printsUntilGone > 0
        ? { stdout: '', stderr: 'Bootstrap failed: 5: Input/output error', code: 5 }
        : { stdout: '', stderr: '', code: 0 };
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`);
  });

  await install();

  assert.equal(calls[0], 'bootout');
  assert.equal(calls.at(-1), 'bootstrap');
  assert.equal(calls.filter((c) => c === 'bootstrap').length, 1);
  assert.equal(printsUntilGone, 0);
});
