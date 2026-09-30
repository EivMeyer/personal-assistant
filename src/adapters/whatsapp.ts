import Database from "better-sqlite3";
import { z } from "zod";
import {
  assertReply,
  type Conversation,
  type Message,
  type Proposal,
  type Route,
  type Source,
} from "../domain.ts";
import { Store } from "../store.ts";
import { requestJson, type Http } from "../http.ts";

interface WhatsAppOptions {
  messagesDb: string;
  sessionDb: string;
  selfJid: string;
  bridgeUrl: string;
  allowGroups: boolean;
  token?: string;
}
interface Row {
  rowid: number;
  id: string;
  chat_jid: string;
  sender: string;
  content: string | null;
  timestamp: string;
  is_from_me: number;
  media_type: string | null;
}
export class WhatsAppSource implements Source {
  readonly id = "whatsapp";
  private readonly db: Database.Database;
  constructor(
    private readonly options: WhatsAppOptions,
    private readonly store: Store,
    private readonly http: Http = requestJson,
  ) {
    this.db = new Database(options.messagesDb, {
      readonly: true,
      fileMustExist: true,
    });
    this.db.pragma("busy_timeout = 5000");
  }
  async verify(): Promise<void> {
    const session = new Database(this.options.sessionDb, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const devices = session
        .prepare("SELECT jid FROM whatsmeow_device")
        .all() as { jid: string }[];
      const normalized = devices.map((device) =>
        device.jid.replace(/:\d+@/, "@"),
      );
      if (normalized.length !== 1 || normalized[0] !== this.options.selfJid)
        throw new Error("WhatsApp identity does not match configuration");
    } finally {
      session.close();
    }
  }
  async poll(): Promise<void> {
    await this.verify();
    const max = (
      this.db
        .prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM messages")
        .get() as { n: number }
    ).n;
    const cursor = this.store.get(`cursor:${this.id}`);
    if (cursor === undefined) {
      this.store.set("whatsapp:started", String(Date.now()));
      this.store.ingest(this.id, [], String(max), Date.now());
      return;
    }
    if (max < Number(cursor))
      throw new Error(
        "WhatsApp database was replaced or rewound; checkpoint needs review",
      );
    const rows = this.db
      .prepare(
        "SELECT rowid,* FROM messages WHERE rowid>? ORDER BY rowid LIMIT 500",
      )
      .all(Number(cursor)) as Row[];
    const started = Number(this.store.get("whatsapp:started"));
    const messages = rows
      .map((row) => this.message(row))
      .filter((message) => message.timestamp >= started - 10_000);
    this.store.ingest(
      this.id,
      messages,
      String(rows.at(-1)?.rowid ?? cursor),
      Date.now(),
    );
  }
  private message(row: Row): Message {
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp))
      throw new Error("Unsupported WhatsApp timestamp");
    return {
      id: `${row.chat_jid}:${row.id}`,
      source: this.id,
      thread: row.chat_jid,
      channel: "whatsapp",
      timestamp,
      sender: row.sender,
      body: row.content ?? "",
      outgoing: Boolean(row.is_from_me),
      attachments: Boolean(row.media_type),
      automated:
        row.chat_jid === "status@broadcast" ||
        (!this.options.allowGroups && row.chat_jid.endsWith("@g.us")),
    };
  }
  async conversation(thread: string): Promise<Conversation> {
    const rows = this.db
      .prepare(
        "SELECT rowid,* FROM messages WHERE chat_jid=? ORDER BY timestamp,rowid LIMIT 5001",
      )
      .all(thread) as Row[];
    const messages = rows.map((row) => this.message(row));
    const gaps: string[] = [];
    if (messages.length > 5000)
      gaps.push("Conversation exceeds supported history limit");
    if (messages.some((message) => message.attachments))
      gaps.push("Media requires review in WhatsApp");
    return {
      source: this.id,
      thread,
      messages,
      complete: gaps.length === 0,
      gaps,
    };
  }
  async route(context: Conversation): Promise<Route | null> {
    const direct = /^\d+@(s\.whatsapp\.net|lid)$/.test(context.thread);
    const group =
      this.options.allowGroups && /^[\d-]+@g\.us$/.test(context.thread);
    if (!direct && !group) return null;
    return {
      channel: "whatsapp",
      account: this.id,
      from: this.options.selfJid,
      to: context.thread,
    };
  }
  async send(proposal: Proposal): Promise<string> {
    assertReply(proposal);
    await this.verify();
    if (
      proposal.route.channel !== "whatsapp" ||
      proposal.route.from !== this.options.selfJid
    )
      throw new Error("Wrong WhatsApp sender");
    const result = z.object({ success: z.boolean() }).parse(
      await this.http(`${this.options.bridgeUrl}/api/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.token
            ? { Authorization: `Bearer ${this.options.token}` }
            : {}),
        },
        body: JSON.stringify({
          recipient: proposal.route.to,
          message: proposal.assessment.draft,
        }),
      }),
    );
    if (!result.success) throw new Error("Bridge did not confirm acceptance");
    return `whatsapp:bridge-accepted:${proposal.id}`;
  }
  close(): void {
    this.db.close();
  }
}
