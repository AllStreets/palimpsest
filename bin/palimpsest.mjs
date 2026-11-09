#!/usr/bin/env node
// Plain ESM entry point: run with `node bin/palimpsest.mjs <command> <subcommand>`.
// Loads the TS engine modules by registering tsx's ESM API, then dynamic-importing them.
import { register } from 'tsx/esm/api';

register();

function usage() {
  console.error('Usage: palimpsest engine start|install|uninstall|status');
  console.error('       palimpsest usage install|uninstall');
}

async function engineCommand(sub) {
  switch (sub) {
    case 'start': {
      // Runs the server in the foreground: import main.ts directly so it keeps
      // this process alive, logs and installs the same SIGTERM/SIGINT handling
      // launchd would rely on.
      await import('../engine/main.ts');
      return;
    }
    case 'install': {
      const { install } = await import('../engine/launchd.ts');
      await install();
      console.log('Palimpsest engine agent installed and loaded.');
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import('../engine/launchd.ts');
      await uninstall();
      console.log('Palimpsest engine agent uninstalled.');
      return;
    }
    case 'status': {
      const { status } = await import('../engine/launchd.ts');
      console.log(await status());
      return;
    }
    default:
      usage();
      process.exitCode = 1;
  }
}

async function usageCommand(sub) {
  if (sub !== 'install' && sub !== 'uninstall') {
    usage();
    process.exitCode = 1;
    return;
  }
  const { claudeSettingsTarget, installHook, NO_CLAUDE_SETTINGS, uninstallHook } = await import('../engine/usage.ts');
  // The same rule as the engine's hook routes: the real settings file only for the default data home.
  const target = claudeSettingsTarget();
  if (target === null) {
    console.error(NO_CLAUDE_SETTINGS);
    process.exitCode = 1;
    return;
  }
  if (sub === 'install') {
    installHook(target);
    console.log(`Usage hook installed into ${target}.`);
  } else {
    uninstallHook(target);
    console.log(`Usage hook uninstalled from ${target}.`);
  }
}

async function main() {
  const [command, sub] = process.argv.slice(2);

  if (command === 'engine') {
    await engineCommand(sub);
    return;
  }
  if (command === 'usage') {
    await usageCommand(sub);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
