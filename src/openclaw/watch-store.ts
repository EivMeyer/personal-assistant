import Database from "better-sqlite3";
export interface IncomingEvent {
  source: string;
  id: string;
  thread: string;
  receivedAt: number;
}
export interface Checkpoint {
  cursor: string;
  checkedAt: number;
}
export class WatchStore {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (source TEXT PRIMARY KEY, cursor TEXT NOT NULL, checkedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        source TEXT NOT NULL, id TEXT NOT NULL, thread TEXT NOT NULL,
        receivedAt INTEGER NOT NULL, detectedAt INTEGER NOT NULL,
        dispatchedAt INTEGER, PRIMARY KEY(source,id)
      );
      CREATE TABLE IF NOT EXISTS incoming_attempts (
        source TEXT NOT NULL, id TEXT NOT NULL, attempts INTEGER NOT NULL,
        lastAttemptAt INTEGER NOT NULL, retryAt INTEGER NOT NULL,
        PRIMARY KEY(source,id)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "processedAt"))
      this.db.exec("ALTER TABLE events ADD COLUMN processedAt INTEGER");
  }
  checkpoint(source: string): Checkpoint | undefined {
    return this.db
      .prepare("SELECT cursor,checkedAt FROM checkpoints WHERE source=?")
      .get(source) as Checkpoint | undefined;
  }
  ingest(
    source: string,
    cursor: string,
    events: IncomingEvent[],
    now: number,
  ): number {
    return this.db.transaction(() => {
      let added = 0;
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO events(source,id,thread,receivedAt,detectedAt) VALUES (?,?,?,?,?)",
      );
      for (const event of events) {
        if (event.source !== source) throw Error("Source mismatch");
        added += insert.run(
          source,
          event.id,
          event.thread,
          event.receivedAt,
          now,
        ).changes;
      }
      this.db
        .prepare(
          "INSERT INTO checkpoints VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,checkedAt=excluded.checkedAt",
        )
        .run(source, cursor, now);
      return added;
    })();
  }
  pending(now = Date.now()): IncomingEvent[] {
    return this.db
      .prepare(
        `WITH eligible AS (
          SELECT e.* FROM events e LEFT JOIN incoming_attempts a USING(source,id)
          WHERE e.processedAt IS NULL AND COALESCE(a.retryAt,0)<=?
        ) SELECT source,id,thread,receivedAt FROM eligible
          WHERE dispatchedAt IS NULL OR (dispatchedAt<? AND NOT EXISTS (
            SELECT 1 FROM eligible WHERE dispatchedAt>=?
          )) ORDER BY detectedAt LIMIT 20`,
      )
      .all(now, now - 60_000, now - 60_000) as IncomingEvent[];
  }
  dispatched(events: IncomingEvent[], now: number): void {
    this.db.transaction(() => {
      const mark = this.db.prepare(
        "UPDATE events SET dispatchedAt=? WHERE source=? AND id=? AND processedAt IS NULL",
      );
      for (const event of events) mark.run(now, event.source, event.id);
    })();
  }
}
