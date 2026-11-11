/**
 * Makes node's randomUUID deterministic for this process (the perf tool):
 * the sample economy names its jobs, runs and bids by random ids, and a
 * floor's lit windows are seeded by its id, so without this two runs light
 * different windows and their stills cannot be compared. Import it first.
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

let n = 0;
crypto.randomUUID = (() => {
  const h = crypto.createHash('sha256').update(`palimpsest-perf-${n++}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}) as typeof crypto.randomUUID;
syncBuiltinESMExports();
