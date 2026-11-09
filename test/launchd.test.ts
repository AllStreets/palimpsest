import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LABEL, plist } from '../engine/launchd.js';

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
