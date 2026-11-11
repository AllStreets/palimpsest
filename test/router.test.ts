/**
 * The app's addresses (Task 36): every screen the market adds, with the id
 * it opens on, parsed from the location hash and written back by placeHref.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHash, placeHref } from '../app/src/router.js';

test('router parses ids', () => {
  assert.deepEqual(parseHash(''), { route: 'city', id: null });
  assert.deepEqual(parseHash('#/'), { route: 'city', id: null });
  assert.deepEqual(parseHash('#/repos'), { route: 'repos', id: null });
  assert.deepEqual(parseHash('#/settings'), { route: 'settings', id: null });
  assert.deepEqual(parseHash('#/jobs'), { route: 'jobs', id: null });
  assert.deepEqual(parseHash('#/jobs/job-1dc44ebb21dc'), { route: 'job', id: 'job-1dc44ebb21dc' });
  assert.deepEqual(parseHash('#/firms'), { route: 'firms', id: null });
  assert.deepEqual(parseHash('#/firms/ashlar-vane'), { route: 'firm', id: 'ashlar-vane' });
  assert.deepEqual(parseHash('#/agents/priya-rao'), { route: 'agent', id: 'priya-rao' });
  assert.deepEqual(parseHash('#/runs/run-0a1b2c3d4e5f'), { route: 'run', id: 'run-0a1b2c3d4e5f' });
  assert.deepEqual(parseHash('#/inspections/insp-9'), { route: 'inspection', id: 'insp-9' });
  assert.deepEqual(parseHash('#/treasury'), { route: 'treasury', id: null });
  assert.deepEqual(parseHash('#/repos/tidewater/harbor-ledger'), { route: 'repo', id: 'tidewater/harbor-ledger' });
  // Ids are percent-decoded, as the city writes them with encodeURIComponent.
  assert.deepEqual(parseHash('#/agents/corin%20hale'), { route: 'agent', id: 'corin hale' });
  // A trailing slash is the same place.
  assert.deepEqual(parseHash('#/jobs/'), { route: 'jobs', id: null });
});

test('router falls back to the city for anything it does not know', () => {
  for (const h of ['#/nowhere', '#/jobs/a/b', '#/repos/onlyowner', '#/repos/a/b/c', '#jobs', '#/agents/', '#/agents/%E0%A4%A', '#/firms/..', '#/runs/a%2Fb']) {
    assert.deepEqual(parseHash(h), { route: 'city', id: null }, h);
  }
});

test('placeHref writes what parseHash reads', () => {
  const places = [
    { route: 'city', id: null },
    { route: 'jobs', id: null },
    { route: 'job', id: 'job-1' },
    { route: 'firm', id: 'kiln' },
    { route: 'agent', id: 'corin hale' },
    { route: 'repo', id: 'tidewater/harbor-ledger' },
    { route: 'treasury', id: null },
  ] as const;
  for (const p of places) assert.deepEqual(parseHash(placeHref(p.route, p.id)), p);
  assert.equal(placeHref('city'), '#/');
  assert.equal(placeHref('jobs'), '#/jobs');
  assert.equal(placeHref('repo', 'tidewater/harbor-ledger'), '#/repos/tidewater/harbor-ledger');
});
