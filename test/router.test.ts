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

test('router parses #/brief and #/audits/:id', () => {
  assert.deepEqual(parseHash('#/brief'), { route: 'brief', id: null });
  assert.deepEqual(parseHash('#/audits/audit-abc123'), { route: 'audit', id: 'audit-abc123' });
  assert.deepEqual(parseHash('#/audits'), { route: 'city', id: null }, 'there is no audits list');
  assert.deepEqual(parseHash('#/audits/a/b'), { route: 'city', id: null });
  assert.equal(placeHref('brief'), '#/brief');
  assert.equal(placeHref('audit', 'audit-abc123'), '#/audits/audit-abc123');
  assert.deepEqual(parseHash(placeHref('audit', 'audit-abc123')), { route: 'audit', id: 'audit-abc123' });
});

test('the router parses the four routes', () => {
  // The school, opened at a section (the observatory's dome opens it at the master's card).
  assert.deepEqual(parseHash('#/school'), { route: 'school', id: null });
  assert.deepEqual(parseHash('#/school/master'), { route: 'school', id: 'master' });
  assert.deepEqual(parseHash('#/school/voyages'), { route: 'school', id: 'voyages' });
  assert.deepEqual(parseHash('#/school/nets'), { route: 'school', id: 'nets' });
  assert.deepEqual(parseHash('#/school/nets/appraiser-pass'), { route: 'net', id: 'appraiser-pass' });
  assert.deepEqual(parseHash('#/school/voyages/voy-1'), { route: 'voyage', id: 'voy-1' });
  assert.deepEqual(parseHash('#/school/graduates/grad-qwen25c7-1'), { route: 'graduate', id: 'grad-qwen25c7-1' });
  for (const h of ['#/school/nowhere', '#/school/nets/a/b', '#/school/master/x', '#/school/nets/..', '#/school/graduates/a%2Fb'])  {
    assert.deepEqual(parseHash(h), { route: 'city', id: null }, h);
  }
  assert.deepEqual(parseHash('#/school/voyages/'), { route: 'school', id: 'voyages' }, 'a trailing slash is the section');
  assert.equal(placeHref('school'), '#/school');
  assert.equal(placeHref('school', 'master'), '#/school/master');
  assert.equal(placeHref('net', 'master'), '#/school/nets/master');
  assert.equal(placeHref('voyage', 'voy-1'), '#/school/voyages/voy-1');
  assert.equal(placeHref('graduate', 'grad-1'), '#/school/graduates/grad-1');
  for (const p of [{ route: 'school', id: null }, { route: 'school', id: 'graduates' }, { route: 'net', id: 'router' }, { route: 'voyage', id: 'voy 2' }, { route: 'graduate', id: 'grad-1' }] as const) {
    assert.deepEqual(parseHash(placeHref(p.route, p.id)), p);
  }
});
