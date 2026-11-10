import { existsSync } from 'node:fs';

import { baseline } from './guild/baseline.js';
import { paths } from './home.js';
import { installedModels, reviveAgents, seedFirms } from './market/firms.js';
import { inspect } from './guild/inspect.js';
import { installDeps } from './market/install.js';
import { pollPRs, ship, watchReverts } from './market/ship.js';
import { dailyTick, DAY_MS, installTreasury } from './market/treasury.js';
import { createScheduler, failInterruptedRuns, shutdownHandler } from './market/runs.js';
import { failInterruptedAnalyses } from './repos.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
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
  // Task 17: the treasury books every payment and cost from the event bus, then once a day settles,
  // sells dark towers, declares bankruptcies and hires (ruling 6).
  installTreasury();
  const runDailyTick = () => {
    try {
      dailyTick(Date.now());
    } catch (err) {
      console.error('palimpsest: the daily treasury tick failed:', err);
    }
  };
  runDailyTick();
  setInterval(runDailyTick, DAY_MS).unref();
  const { close, port } = await startServer();
  const stopped = existsSync(paths().stop);
  // eslint-disable-next-line no-console
  console.log(`Palimpsest engine listening on 127.0.0.1:${port} (stop file ${stopped ? 'present' : 'absent'})`);
  // The scheduler always starts; each tick does nothing while the stop file is set, so clearing it
  // resumes the market without a restart.
  const scheduler = createScheduler({
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
  });
  scheduler.start();

  // A first signal stops the market (runs killed and reaped, leases aborted) within a 10 s grace; a second exits at once.
  // eslint-disable-next-line no-console
  const shutdown = shutdownHandler(scheduler, { close, exit: (code) => process.exit(code), log: (l) => console.log(l) });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Palimpsest engine failed to start:', err);
  process.exit(1);
});
