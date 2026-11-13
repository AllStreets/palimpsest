/**
 * A sample engine's start (engine/main.ts runs it on a sample home). Kept
 * apart from sample.ts, which the budget's readers import, so the stand-ins
 * never pull the market in behind them.
 */
import { installProposals } from './audit/proposals.js';
import { setRunner } from './exec.js';
import { installedModels, reviveAgents, seedFirms } from './market/firms.js';
import { backfillMilestones, installMilestones } from './market/milestones.js';
import { installTreasury } from './market/treasury.js';
import { failInterruptedAnalyses } from './repos.js';
import { sampleGh, useSampleFolders } from './sample.js';
import { ensureCampus } from './school/campus.js';

/**
 * Everything a sample engine does before it listens (engine/main.ts runs it
 * on a sample home): gh, git and `ollama list` answer from the sample
 * stand-in, the budget reads the sample's own folders, the firms are seeded
 * on the sample's installed models, the university takes its plot (Phase 4
 * ruling 27), and the treasury, proposals and milestones listen. Its runs are
 * scripted, so none is failed here.
 */
export async function bootSampleEngine(): Promise<void> {
  setRunner(sampleGh());
  useSampleFolders();
  failInterruptedAnalyses();
  const installed = await installedModels();
  seedFirms(installed);
  reviveAgents(installed);
  ensureCampus();
  installTreasury();
  installProposals();
  installMilestones();
  try {
    backfillMilestones(Date.now());
  } catch (err) {
    console.error('palimpsest: the milestone backfill failed:', err);
  }
}
