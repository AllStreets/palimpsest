/** Whose estimate a bid shows on the jobs sheet (Phase 4 Task 14). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPRAISER_ESTIMATE, BID_TERMS, estimateCellTip, estimateHeaderTip, estimateSource, FIRM_ESTIMATE } from '../app/src/ui/bid-words.js';

test("the firm's estimate keeps Phase 2's words, and the appraiser's says it is the school's", () => {
  assert.equal(FIRM_ESTIMATE, "How often this firm's work of this size has passed");
  assert.equal(estimateSource({}), 'firm', 'a bid from before Phase 4');
  assert.equal(estimateHeaderTip([{}, { appraisalSource: 'firm' }]), FIRM_ESTIMATE);
  assert.equal(estimateHeaderTip([]), FIRM_ESTIMATE);
  assert.equal(estimateHeaderTip([{ appraisalSource: 'appraiser' }]), APPRAISER_ESTIMATE);
  assert.match(APPRAISER_ESTIMATE, /school's appraiser/);
  assert.match(APPRAISER_ESTIMATE, /pass/);
  const mixed = estimateHeaderTip([{ appraisalSource: 'appraiser' }, { appraisalSource: 'firm' }]);
  assert.match(mixed, /appraiser/);
  assert.match(mixed, /this firm's work of this size/);
  assert.equal(estimateCellTip({ appraisal: 0.6, appraisalSource: 'appraiser' }), APPRAISER_ESTIMATE);
  assert.equal(estimateCellTip({ appraisal: 0.6 }), FIRM_ESTIMATE);
  assert.equal(estimateCellTip({ appraisal: null, appraisalSource: 'firm' }), 'No estimate yet');
});

test("the market's terms are glossed where the bids are read, in plain words (audit 2026-11-17)", () => {
  const terms = new Map(BID_TERMS.map((t) => [t.term, t]));
  assert.deepEqual([...terms.keys()], ['Price', 'Stated', 'Calibrated', 'EV']);
  assert.match(terms.get('Stated')!.means, /how sure the firm said it was/i);
  assert.match(terms.get('Calibrated')!.means, /trimmed/);
  assert.equal(terms.get('EV')!.name, 'expected value');
  assert.match(terms.get('EV')!.means, /worth, times the calibrated chance, less the price/);
  assert.match(terms.get('EV')!.means, /highest wins/);
  assert.match(terms.get('EV')!.means, /cheaper bid can lose/);
  for (const t of BID_TERMS) assert.doesNotMatch(t.means, /\u2014|\u2013|--/);
});

test('a job cooling off says plainly that no firm took it and when bids open next', async () => {
  const { nextBidsWords } = await import('../app/src/ui/bid-words.js');
  const now = new Date(2026, 10, 19, 21, 0).getTime();
  assert.equal(nextBidsWords(1, new Date(2026, 10, 19, 21, 40).toISOString(), now), 'No firm took it last round. Next bids at 21:40.');
  assert.equal(nextBidsWords(4, new Date(2026, 10, 19, 23, 20).toISOString(), now), 'No firm took it in the last 4 rounds. Next bids at 23:20.');
  assert.equal(nextBidsWords(9, new Date(2026, 10, 20, 21, 0).toISOString(), now), 'No firm took it in the last 9 rounds. Next bids tomorrow at 21:00.');
});
