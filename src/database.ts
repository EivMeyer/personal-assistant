import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true });
  if (version !== 0 && version !== 1)
    throw new Error("Unsupported database version");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      source TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL,
      payload TEXT NOT NULL, received_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, id)
    );
    CREATE INDEX IF NOT EXISTS events_pending ON events(done, received_at);
    CREATE TABLE IF NOT EXISTS jobs (
      source TEXT NOT NULL, thread TEXT NOT NULL, due INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source, thread)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, thread TEXT NOT NULL,
      state TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proposals_thread ON proposals(source, thread, state);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS telegram_cards (
      message_id INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      kind TEXT NOT NULL, entity TEXT NOT NULL, detail TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  return db;
}
