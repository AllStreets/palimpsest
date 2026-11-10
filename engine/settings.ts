import type { Settings } from '../shared/types.js';
import { openDb } from './db.js';

const DEFAULTS: Settings = {
  quality: 'high',
  dayCapPct: 50,
  nightCapPct: 20,
  hookInstalled: false,
  previousStatusLine: null,
  claudeConcurrency: 2,
  localConcurrency: 1,
  bidWindowSec: 120,
  hardStopPct: 90,
  resumeStaleUntil: null,
  keepAwake: false,
  ollamaHost: '127.0.0.1:11434',
  anthropicApi: { enabled: false, dailyUsd: 5 },
};

/** Current settings, defaults filled in for any key not yet stored. */
export function getSettings(): Settings {
  const db = openDb();
  const rows = db.prepare('SELECT key, json FROM settings').all() as Array<{ key: string; json: string }>;
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    stored[row.key] = JSON.parse(row.json);
  }
  const merged = { ...DEFAULTS, ...stored } as Settings;
  // Nested settings take their defaults key by key, so an older or partial stored value never drops one.
  const api = stored.anthropicApi;
  merged.anthropicApi = { ...DEFAULTS.anthropicApi, ...(api && typeof api === 'object' && !Array.isArray(api) ? api : {}) };
  return merged;
}

/** Merges `p` into the stored settings (one row per key) and returns the result. */
export function patchSettings(p: Partial<Settings>): Settings {
  const db = openDb();
  const stmt = db.prepare(
    'INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  );
  for (const [key, value] of Object.entries(p)) {
    stmt.run(key, JSON.stringify(value));
  }
  return getSettings();
}
