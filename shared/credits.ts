/**
 * Credit maths (rulings 1 and 2). One credit is a tenth of a percent of the
 * five-hour window. Claude usage is measured in weighted tokens, local
 * models by wall time and model size, the Anthropic API by dollars.
 * Imports nothing from engine/.
 */
import { CREDITS_PER_USD } from './market-rules.js';

/** Percent of the five-hour window one credit stands for. */
export const CREDIT_PCT = 0.1;
/** Weighted tokens per percent of the five-hour window, until calibration measures it. */
export const DEFAULT_TOKENS_PER_PCT = 60_000;
/** Per-family multiplier, from the list price ratios. */
export const MODEL_WEIGHT = { haiku: 0.2, sonnet: 0.6, opus: 1, fable: 1 } as const;
/** How much a new observation moves the tokens-per-percent estimate. */
export const CALIBRATION_ALPHA = 0.3;

export type ModelFamily = keyof typeof MODEL_WEIGHT;

/** The model's family from any spelling (`claude-sonnet-4-5`, `claude:haiku`, `anthropic:claude-opus-4`); an unknown family counts as opus. */
export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  for (const family of Object.keys(MODEL_WEIGHT) as ModelFamily[]) {
    if (m.includes(family)) return family;
  }
  return 'opus';
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** (input + 5 * output + 0.1 * cacheRead + 1.25 * cacheCreation) * MODEL_WEIGHT[family]. */
export function weightedTokens(u: TokenUsage, model: string): number {
  const raw = u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheCreation;
  return Math.round(raw * MODEL_WEIGHT[modelFamily(model)] * 1e6) / 1e6;
}

/** Credits for Claude usage: weighted tokens over tokens per percent, in tenths of a percent. */
export function claudeCredits(weighted: number, tokensPerPct: number): number {
  return Math.round((weighted / tokensPerPct / CREDIT_PCT) * 1e9) / 1e9;
}

/** Credits for a local model run: seconds * (0.001 + 0.0001 * modelGB). */
export function localCredits(seconds: number, modelGB: number): number {
  return Math.round(seconds * (0.001 + 0.0001 * modelGB) * 1e9) / 1e9;
}

/** Credits for Anthropic API spend. */
export function apiCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD * 1e9) / 1e9;
}

/** Blends a new tokens-per-percent observation into the previous estimate (EMA, alpha 0.3). */
export function calibrate(prev: number, observed: number): number {
  return Math.round(((1 - CALIBRATION_ALPHA) * prev + CALIBRATION_ALPHA * observed) * 1e6) / 1e6;
}

/** The percent of the five-hour window a number of credits stands for. */
export function pctFor(credits: number): number {
  return Math.round(credits * CREDIT_PCT * 1e9) / 1e9;
}
