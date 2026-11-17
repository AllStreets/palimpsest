/**
 * Whose estimate a bid shows (Phase 4 Task 14, Decision 14), kept free of
 * the page so the tests can read it: the firm's pass rate at the job's size,
 * as in Phase 2, or the school's appraiser once it is trusted and on.
 */
import type { Bid } from '../../../shared/types.js';

/** The phrase under the "City's estimate" header for the firm's pass rate (Phase 2's words). */
export const FIRM_ESTIMATE = "How often this firm's work of this size has passed";
/** The phrase for the school's appraiser. */
export const APPRAISER_ESTIMATE = "The school's appraiser: its estimate that this work will pass";

/** The source of a bid's estimate; a bid placed before Phase 4 carries none and is the firm's. */
export function estimateSource(b: Pick<Bid, 'appraisalSource'>): 'firm' | 'appraiser' {
  return b.appraisalSource === 'appraiser' ? 'appraiser' : 'firm';
}

/** The header's tooltip: Phase 2's words when every bid's estimate is the firm's, else says which is which. */
export function estimateHeaderTip(bids: ReadonlyArray<Pick<Bid, 'appraisalSource'>>): string {
  const sources = new Set(bids.map(estimateSource));
  if (!sources.has('appraiser')) return FIRM_ESTIMATE;
  if (!sources.has('firm')) return APPRAISER_ESTIMATE;
  return `${APPRAISER_ESTIMATE}, or where a bid has none, ${FIRM_ESTIMATE.charAt(0).toLowerCase()}${FIRM_ESTIMATE.slice(1)}`;
}

/** One cell's tooltip: whose estimate this bid's is. */
export function estimateCellTip(b: Pick<Bid, 'appraisalSource' | 'appraisal'>): string {
  if (b.appraisal === null) return 'No estimate yet';
  return estimateSource(b) === 'appraiser' ? APPRAISER_ESTIMATE : FIRM_ESTIMATE;
}

/**
 * The market's own words, glossed where the bids are read (audit 2026-11-17): one plain line above each bid
 * table, and the same words as each column head's definition on hover. A first-timer should be able to read
 * "won at 27.97 credits" and "an expected value of 14.03" from these alone.
 */
export const BID_TERMS: ReadonlyArray<{ term: string; name: string; means: string }> = [
  { term: 'Price', name: 'price', means: 'what the firm asks for the work, in credits' },
  { term: 'Stated', name: 'stated chance', means: 'how sure the firm said it was that its work would pass' },
  { term: 'Calibrated', name: 'calibrated chance', means: 'that chance as the city counts it, trimmed when the firm’s past bids claimed more than its work bore out' },
  { term: 'EV', name: 'expected value', means: 'what the job is worth, times the calibrated chance, less the price; the highest wins, so a cheaper bid can lose to one more likely to pass' },
];
