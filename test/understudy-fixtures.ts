/**
 * Understudy databases built from its schema (Phase 4 ruling 10, the
 * `pairs` and `statements` tables as Understudy's own store creates them),
 * always in a temp dir. No test ever opens his real Understudy database.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists pairs (
  id text primary key,
  at text not null,
  project text,
  url text not null,
  dimension text not null,
  question text not null,
  a_label text not null, a_css text not null, a_shot text not null,
  b_label text not null, b_css text not null, b_shot text not null,
  pick text,
  picked_at text
);
create table if not exists statements (
  id text primary key,
  text text not null,
  aspect text not null,
  evidence text not null,
  weight real not null default 1,
  edited integer not null default 0,
  removed integer not null default 0
);
`;

export interface FixtureStatement {
  id: string;
  text: string;
  weight?: number;
  removed?: boolean;
}
export interface FixturePair {
  id: string;
  at: string;
  pick: string | null;
  aShot?: string;
  bShot?: string;
}

/** Writes an Understudy database at `<dir>/understudy.db` and returns its path; `wal` leaves it in WAL mode. */
export function makeUnderstudy(dir: string, o: { statements?: FixtureStatement[]; pairs?: FixturePair[]; wal?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'understudy.db');
  const db = new DatabaseSync(path);
  if (o.wal) db.exec('pragma journal_mode = wal');
  db.exec(SCHEMA);
  const s = db.prepare('insert into statements (id, text, aspect, evidence, weight, removed) values (?, ?, ?, ?, ?, ?)');
  for (const x of o.statements ?? []) s.run(x.id, x.text, 'look', '[]', x.weight ?? 1, x.removed ? 1 : 0);
  const p = db.prepare(
    'insert into pairs (id, at, project, url, dimension, question, a_label, a_css, a_shot, b_label, b_css, b_shot, pick, picked_at) values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const x of o.pairs ?? []) {
    p.run(x.id, x.at, 'http://127.0.0.1:5173/', 'spacing', 'Which reads calmer?', 'tight', 'body{}', x.aShot ?? join(dir, `${x.id}-a.png`), 'loose', 'body{}', x.bShot ?? join(dir, `${x.id}-b.png`), x.pick, x.pick ? x.at : null);
  }
  db.close();
  return path;
}

/** Writes `png` at both of a pair's default shot paths. */
export function writeShots(dir: string, id: string, png: Buffer): void {
  writeFileSync(join(dir, `${id}-a.png`), png);
  writeFileSync(join(dir, `${id}-b.png`), png);
}
