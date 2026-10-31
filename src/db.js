import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, 'clan.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS members(
  tag TEXT PRIMARY KEY, name TEXT, role TEXT, first_seen TEXT, baseline INTEGER DEFAULT 0,
  left_at TEXT, active INTEGER DEFAULT 1, exp_level INTEGER, trophies INTEGER,
  donations INTEGER, donations_received INTEGER, last_seen TEXT, clan_rank INTEGER);
CREATE TABLE IF NOT EXISTS member_snaps(
  ts TEXT, tag TEXT, role TEXT, trophies INTEGER, donations INTEGER, donations_received INTEGER, last_seen TEXT,
  PRIMARY KEY(ts, tag));
CREATE TABLE IF NOT EXISTS clan_snaps(
  ts TEXT PRIMARY KEY, members INTEGER, clan_score INTEGER, war_trophies INTEGER, donations_per_week INTEGER);
CREATE TABLE IF NOT EXISTS war_snaps(
  ts TEXT, section_index INTEGER, period_index INTEGER, period_type TEXT, tag TEXT,
  fame INTEGER, repair_points INTEGER, boat_attacks INTEGER, decks_used INTEGER, decks_used_today INTEGER,
  PRIMARY KEY(ts, tag));
CREATE TABLE IF NOT EXISTS wars(
  season_id INTEGER, section_index INTEGER, ended_at TEXT, rank INTEGER, trophy_change INTEGER,
  fame INTEGER, repair_points INTEGER, finish_time TEXT, clan_score INTEGER, period_points INTEGER,
  standings_json TEXT, PRIMARY KEY(season_id, section_index));
CREATE TABLE IF NOT EXISTS war_players(
  season_id INTEGER, section_index INTEGER, tag TEXT, name TEXT, fame INTEGER, repair_points INTEGER,
  boat_attacks INTEGER, decks_used INTEGER, PRIMARY KEY(season_id, section_index, tag));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, type TEXT, tag TEXT, name TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS actions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, tag TEXT, name TEXT, type TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS excuses(
  id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT, from_date TEXT, to_date TEXT, reason TEXT);
`);

try { db.exec('ALTER TABLE members ADD COLUMN joined_manual TEXT'); } catch { /* already there */ }

export const kvGet = (key, fallback = null) => {
  const r = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
};
export const kvSet = (key, value) =>
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
