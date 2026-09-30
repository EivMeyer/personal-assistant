import Database from "better-sqlite3";
import type { Checkpoint } from "./watch-store.ts";
import type { Scan } from "./watch-gmail.ts";
interface Row {
  rowid: number;
  id: string;
  chat_jid: string;
  timestamp: string;
  is_from_me: number;
}
export class WhatsAppWatch {
  readonly source = "whatsapp";
  readonly db: Database.Database;
  constructor(
    path: string,
    private startAt: number,
  ) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 3000");
  }
  async scan(checkpoint?: Checkpoint): Promise<Scan> {
    const maximum = (
      this.db
        .prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM messages")
        .get() as { n: number }
    ).n;
    const cursor = checkpoint ? Number(checkpoint.cursor) : maximum;
    if (maximum < cursor) throw Error("WhatsApp database was rewound");
    const rows = this.db
      .prepare(
        "SELECT rowid,id,chat_jid,timestamp,is_from_me FROM messages WHERE rowid>? ORDER BY rowid LIMIT 500",
      )
      .all(cursor) as Row[];
    const events = rows
      .filter((row) => !row.is_from_me && row.chat_jid !== "status@broadcast")
      .map((row) => ({
        source: this.source,
        id: row.id,
        thread: row.chat_jid,
        receivedAt: Date.parse(row.timestamp),
      }));
    if (events.some((event) => !Number.isFinite(event.receivedAt)))
      throw Error("Invalid WhatsApp timestamp");
    return {
      cursor: String(rows.at(-1)?.rowid ?? cursor),
      events: events.filter((event) => event.receivedAt >= this.startAt),
    };
  }
}
