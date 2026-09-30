import type Database from "better-sqlite3";
import type { Message, Proposal } from "./domain.ts";

export interface Job {
  source: string;
  thread: string;
  due: number;
  attempts: number;
}
export interface Outgoing {
  text?: string;
  proposalId?: string;
  version?: number;
  forceReply?: boolean;
}
export interface OutboxRow {
  id: number;
  payload: string;
  attempts: number;
}

export class Store {
  constructor(readonly db: Database.Database) {}
  get(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  ingest(
    source: string,
    messages: Message[],
    cursor: string,
    now: number,
  ): void {
    this.db.transaction(() => {
      for (const message of messages) this.addEvent(message, now);
      this.set(`cursor:${source}`, cursor);
      this.set(`sync:${source}`, String(now));
    })();
  }
  private addEvent(message: Message, now: number): void {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO events(source,id,thread,payload,received_at) VALUES (?,?,?,?,?)",
      )
      .run(
        message.source,
        message.id,
        message.thread,
        JSON.stringify(message),
        now,
      );
    if (result.changes === 0) return;
    this.schedule(message.source, message.thread, now + 10_000);
  }
  schedule(source: string, thread: string, due: number): void {
    this.db
      .prepare(
        `INSERT INTO jobs VALUES (?,?,?,0) ON CONFLICT(source,thread)
      DO UPDATE SET due=excluded.due, attempts=0`,
      )
      .run(source, thread, due);
  }
  jobs(now: number): Job[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE due<=? ORDER BY due LIMIT 10")
      .all(now) as Job[];
  }
  finish(job: Job): void {
    this.db
      .prepare("UPDATE events SET done=1 WHERE source=? AND thread=?")
      .run(job.source, job.thread);
    this.db
      .prepare("DELETE FROM jobs WHERE source=? AND thread=?")
      .run(job.source, job.thread);
  }
  fail(job: Job, now: number): void {
    const delay = Math.min(3_600_000, 15_000 * 2 ** Math.min(job.attempts, 8));
    this.db
      .prepare(
        "UPDATE jobs SET due=?,attempts=attempts+1 WHERE source=? AND thread=?",
      )
      .run(now + delay, job.source, job.thread);
  }
  proposal(id: string): Proposal | undefined {
    const row = this.db
      .prepare("SELECT payload FROM proposals WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Proposal) : undefined;
  }
  save(proposal: Proposal): void {
    this.db
      .prepare(
        `INSERT INTO proposals VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state, version=excluded.version, payload=excluded.payload`,
      )
      .run(
        proposal.id,
        proposal.source,
        proposal.thread,
        proposal.state,
        proposal.version,
        JSON.stringify(proposal),
      );
  }
  proposals(states: string[]): Proposal[] {
    return (
      this.db
        .prepare(
          `SELECT payload FROM proposals WHERE state IN (${states.map(() => "?").join(",")})`,
        )
        .all(...states) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as Proposal);
  }
  supersede(source: string, thread: string): void {
    for (const proposal of this.proposals([
      "pending",
      "needs_input",
      "snoozed",
    ])) {
      if (proposal.source === source && proposal.thread === thread)
        this.save({ ...proposal, state: "superseded" });
    }
  }
  enqueue(dedupe: string, outgoing: Outgoing, now: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(dedupe,payload,due) VALUES (?,?,?)",
      )
      .run(dedupe, JSON.stringify(outgoing), now);
  }
  outbox(now: number): OutboxRow[] {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE delivered=0 AND due<=? ORDER BY id LIMIT 20",
      )
      .all(now) as OutboxRow[];
  }
  delivered(id: number, messageId: number, outgoing: Outgoing): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE outbox SET delivered=1 WHERE id=?").run(id);
      if (outgoing.proposalId && outgoing.version) {
        this.db
          .prepare("INSERT OR REPLACE INTO telegram_cards VALUES (?,?,?)")
          .run(messageId, outgoing.proposalId, outgoing.version);
      }
    })();
  }
  retryOutbox(row: OutboxRow, now: number): void {
    const delay = Math.min(3_600_000, 10_000 * 2 ** Math.min(row.attempts, 9));
    this.db
      .prepare("UPDATE outbox SET attempts=attempts+1,due=? WHERE id=?")
      .run(now + delay, row.id);
  }
  card(
    messageId: number,
  ): { proposal_id: string; version: number } | undefined {
    return this.db
      .prepare(
        "SELECT proposal_id,version FROM telegram_cards WHERE message_id=?",
      )
      .get(messageId) as { proposal_id: string; version: number } | undefined;
  }
  audit(kind: string, entity: string, detail: string, now: number): void {
    this.db
      .prepare("INSERT INTO audit(at,kind,entity,detail) VALUES (?,?,?,?)")
      .run(now, kind, entity, detail);
  }
}
