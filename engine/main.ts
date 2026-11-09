import { existsSync } from 'node:fs';

import { paths } from './home.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const { close, port } = await startServer();
  const stopped = existsSync(paths().stop);
  // eslint-disable-next-line no-console
  console.log(`Palimpsest engine listening on 127.0.0.1:${port} (stop file ${stopped ? 'present' : 'absent'})`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`Palimpsest engine received ${signal}, shutting down`);
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Palimpsest engine failed to start:', err);
  process.exit(1);
});
