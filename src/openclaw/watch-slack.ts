import { z } from "zod";
import { requestJson, type Http } from "../http.ts";
import type { Checkpoint, IncomingEvent } from "./watch-store.ts";
import type { Scan } from "./watch-gmail.ts";
const responseSchema = z.object({
  ok: z.literal(true),
  messages: z.object({
    paging: z.object({ pages: z.number() }),
    matches: z.array(
      z.object({
        ts: z.string(),
        user: z.string().optional(),
        channel: z.object({ id: z.string() }),
      }),
    ),
  }),
});
export class SlackWatch {
  readonly source = "slack";
  private verified = false;
  constructor(
    private token: string,
    private identity: { user: string; team: string },
    private startAt: number,
    private http: Http = requestJson,
  ) {}
  private request(
    method: string,
    query: URLSearchParams = new URLSearchParams(),
  ) {
    return this.http(`https://slack.com/api/${method}?${query}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }
  private async verify() {
    if (this.verified) return;
    const auth = z
      .object({ ok: z.literal(true), user_id: z.string(), team_id: z.string() })
      .parse(await this.request("auth.test"));
    if (
      auth.user_id !== this.identity.user ||
      auth.team_id !== this.identity.team
    )
      throw Error("Slack identity mismatch");
    this.verified = true;
  }
  async scan(checkpoint?: Checkpoint): Promise<Scan> {
    await this.verify();
    const now = Date.now();
    const since = checkpoint ? checkpoint.checkedAt - 120000 : this.startAt;
    const events = new Map<string, IncomingEvent>();
    for (const query of ["to:me", `<@${this.identity.user}>`]) {
      for (const event of await this.search(query, since))
        events.set(event.id, event);
    }
    return { cursor: String(now), events: [...events.values()] };
  }
  private async search(query: string, since: number): Promise<IncomingEvent[]> {
    const date = new Date(since - 86400000).toISOString().slice(0, 10);
    const events: IncomingEvent[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({
        query: `${query} after:${date}`,
        sort: "timestamp",
        sort_dir: "desc",
        count: "100",
        page: String(page),
      });
      const result = responseSchema.parse(
        await this.request("search.messages", params),
      ).messages;
      for (const message of result.matches) {
        const receivedAt = Number(message.ts) * 1000;
        if (!Number.isFinite(receivedAt))
          throw Error("Invalid Slack timestamp");
        if (receivedAt >= since && message.user !== this.identity.user)
          events.push({
            source: this.source,
            id: `${message.channel.id}:${message.ts}`,
            thread: message.channel.id,
            receivedAt,
          });
      }
      const oldest = result.matches.at(-1);
      if (
        page >= result.paging.pages ||
        !oldest ||
        Number(oldest.ts) * 1000 < since
      )
        break;
    }
    return events;
  }
}
