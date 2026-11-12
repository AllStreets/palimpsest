import { existsSync } from 'node:fs';

import { installProposals } from './audit/proposals.js';

import { baseline } from './guild/baseline.js';
import { paths } from './home.js';
import { installedModels, reviveAgents, seedFirms } from './market/firms.js';
import { inspect } from './guild/inspect.js';
import { installDeps } from './market/install.js';
import { backfillMilestones, installMilestones } from './market/milestones.js';
import { pollPRs, ship, watchReverts } from './market/ship.js';
import { bankruptcyTick, dailyTick, DAY_MS, HOUR_MS, installTreasury } from './market/treasury.js';
import { backfillReports, ensureDailyReport, latestReportDay } from './market/report.js';
import { createScheduler, failInterruptedRuns, shutdownHandler } from './market/runs.js';
import { failInterruptedAnalyses } from './repos.js';
import { setRunner } from './exec.js';
import { isSampleHome, sampleGh, useSampleFolders } from './sample.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  // A sample home (tools/sample.ts) reaches nothing real, from the first call on: `ollama list` and gh go to the
  // sample stand-in and the budget reads the sample's own folders. Its runs are scripted, so none is failed here.
  if (isSampleHome()) return sampleMain();
  // An analysis the last engine was running when it stopped can never finish: say so, with a Retry.
  failInterruptedAnalyses();
  // Likewise a run the last engine had live: its strays are reaped, it ends crashed and its job returns to the board once (ruling 16).
  await failInterruptedRuns();
  // The five firms are seeded here and only here (never inside startServer, so tests never run ollama list).
  // An agent whose Ollama model is not installed seeds retired; seeding is idempotent per firm.
  const installed = await installedModels();
  seedFirms(installed);
  // An agent that seeded retired for a missing model comes back once that model is installed.
  reviveAgents(installed);
  // Task 17: the treasury books every payment and cost from the event bus. Every hour it checks
  // for bankruptcy (72 hours below zero); once a day it sells dark towers and hires (ruling 6).
  installTreasury();
  // Phase 3 Task 5: every verified gap a done audit found becomes a proposed job that waits for his click.
  installProposals();
  // Phase 3 Task 7: the spire, the finial, revivals and ribbons from the floors as they go up, backfilled once from the towers.
  installMilestones();
  try {
    backfillMilestones(Date.now());
  } catch (err) {
    console.error('palimpsest: the milestone backfill failed:', err);
  }
  const every = (name: string, fn: (now: number) => void, ms: number) => {
    const once = () => {
      try {
        fn(Date.now());
      } catch (err) {
        console.error(`palimpsest: the ${name} failed:`, err);
      }
    };
    once();
    setInterval(once, ms).unref();
  };
  every('bankruptcy check', bankruptcyTick, HOUR_MS);
  every('daily treasury tick', dailyTick, DAY_MS);
  const { close, port } = await startServer();
  const stopped = existsSync(paths().stop);
  // eslint-disable-next-line no-console
  console.log(`Palimpsest engine listening on 127.0.0.1:${port} (stop file ${stopped ? 'present' : 'absent'})`);
  // The scheduler always starts; each tick does nothing while the stop file is set, so clearing it
  // resumes the market without a restart.
  // Task 18 ruling: a past day with ledger entries and no report (the engine was down at midnight) gets one now,
  // and the scheduler's last day seen starts from the newest report, so the day in progress is reported when it ends.
  try {
    backfillReports();
  } catch (err) {
    console.error('palimpsest: the daily report backfill failed:', err);
  }
  const scheduler = createScheduler({
    lastDay: latestReportDay(),
    installDeps,
    // Ruling 12: the repo's checks at the run's base commit, cached per sha, in its own run root.
    baseline,
    // Task 15: the inspection guild (checks against the baseline, scope, another firm's review, design).
    inspect,
    // Task 16: a PR (or, in push mode past every gate, a fast-forward of the default branch) from the engine's own clone.
    ship,
    // Task 16: every waiting PR every five minutes, every repo with lit floors every thirty for a revert.
    pollPRs,
    watchReverts,
    // Task 18: once a local day has ended, its report (reports/<day>.md) says what the market did and what waits on him.
    daily: async (day) => {
      ensureDailyReport(day);
    },
  });
  scheduler.start();

  // A first signal stops the market (runs killed and reaped, leases aborted) within a 10 s grace; a second exits at once.
  // eslint-disable-next-line no-console
  const shutdown = shutdownHandler(scheduler, { close, exit: (code) => process.exit(code), log: (l) => console.log(l) });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * The engine on a sample home: the firms (on the sample's installed models)
 * and the treasury, but no scheduler, no PR poll and no daily ticks. The
 * sample economy's clock (PALIMPSEST_SAMPLE_ECONOMY=live, started by
 * startServer) is all that moves the market, on the fake provider.
 */
async function sampleMain(): Promise<void> {
  setRunner(sampleGh());
  useSampleFolders();
  failInterruptedAnalyses();
  const installed = await installedModels();
  seedFirms(installed);
  reviveAgents(installed);
  installTreasury();
  installProposals();
  installMilestones();
  try {
    backfillMilestones(Date.now());
  } catch (err) {
    console.error('palimpsest: the milestone backfill failed:', err);
  }
  const { close, port } = await startServer();
  // eslint-disable-next-line no-console
  console.log(`Palimpsest sample engine listening on 127.0.0.1:${port} (economy ${process.env.PALIMPSEST_SAMPLE_ECONOMY === 'live' ? 'live' : 'still'})`);
  const stop = () => {
    void close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('Palimpsest engine failed to start:', err);
  process.exit(1);
});
