import { DatabaseSync } from 'node:sqlite';
import { paths } from './home.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    full_name TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS towers (
    repo TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
`;

// Cached per resolved db file path, so a changed PALIMPSEST_HOME (as every
// test gives itself a fresh temp dir) opens a fresh connection instead of
// reusing one pointed at a previous test's database.
const connections = new Map<string, DatabaseSync>();

export function openDb(): DatabaseSync {
  const dbPath = paths().db;
  let db = connections.get(dbPath);
  if (!db) {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    connections.set(dbPath, db);
  }
  return db;
}
