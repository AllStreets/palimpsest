/** Whose estimate a bid shows on the jobs sheet (Phase 4 Task 14). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPRAISER_ESTIMATE, estimateCellTip, estimateHeaderTip, estimateSource, FIRM_ESTIMATE } from '../app/src/ui/bid-words.js';

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
