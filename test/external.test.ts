/**
 * Links that leave the city: inside the Mac app they go through the shell's
 * open_external command, in a plain browser through window.open, and only
 * http(s) ever leaves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { externalHref, openExternal, tauriInvoke, type ExternalEnv } from '../app/src/ui/external.js';

const PR = 'https://github.com/AllStreets/palimpsest/pull/13';

function env(invoke: ExternalEnv['invoke']) {
  const opened: Array<[string, string, string]> = [];
  const e: ExternalEnv = { invoke, open: (u, t, f) => opened.push([u, t, f]), base: 'http://127.0.0.1:4796/#/brief' };
  return { e, opened };
}

test('inside the app a link goes to the shell, not to window.open', async () => {
  const calls: Array<[string, unknown]> = [];
  const { e, opened } = env(async (cmd, args) => {
    calls.push([cmd, args]);
  });
  assert.equal(await openExternal(PR, e), 'app');
  assert.deepEqual(calls, [['open_external', { url: PR }]]);
  assert.deepEqual(opened, []);
});

test('in a plain browser a link opens a new tab', async () => {
  const { e, opened } = env(null);
  assert.equal(await openExternal(PR, e), 'browser');
  assert.deepEqual(opened, [[PR, '_blank', 'noopener,noreferrer']]);
});

test('a shell that refuses still leaves the browser a chance', async () => {
  const { e, opened } = env(async () => {
    throw new Error('Command open_external not allowed by ACL');
  });
  assert.equal(await openExternal(PR, e), 'browser');
  assert.deepEqual(opened, [[PR, '_blank', 'noopener,noreferrer']]);
});

test('only http and https leave; a relative link resolves against the page', async () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'x-apple.systempreferences:x', 'data:text/html,hi']) {
    let asked = false;
    const { e, opened } = env(async () => {
      asked = true;
    });
    assert.equal(await openExternal(bad, e), 'refused', bad);
    assert.equal(asked, false, bad);
    assert.deepEqual(opened, [], bad);
  }
  assert.equal(externalHref('/api/inspections/i/shot/r/after', 'http://127.0.0.1:4796/#/job/x'), 'http://127.0.0.1:4796/api/inspections/i/shot/r/after');
});

test('tauriInvoke finds the app by its injected internals and is null in a browser', () => {
  const fn = async () => {};
  assert.equal(tauriInvoke({ __TAURI_INTERNALS__: { invoke: fn } }), fn);
  assert.equal(tauriInvoke({ __TAURI__: { core: { invoke: fn } } }), fn);
  assert.equal(tauriInvoke({}), null);
});
