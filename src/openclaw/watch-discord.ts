import { DiscordApi, type DiscordMessage } from "./discord-api.ts";
import type { Checkpoint, IncomingEvent } from "./watch-store.ts";
import type { Scan } from "./watch-gmail.ts";
export class DiscordWatch {
  readonly source = "discord";
  private api: DiscordApi;
  private startAt: number;
  constructor(api: DiscordApi, startAt: number) {
    this.api = api;
    this.startAt = startAt;
  }
  async scan(checkpoint?: Checkpoint): Promise<Scan> {
    await this.api.verify();
    const now = Date.now();
    const since = checkpoint ? checkpoint.checkedAt - 120000 : this.startAt;
    const parents = await this.api.channels();
    const channels = new Map(
      parents.filter((c) => [0, 5].includes(c.type)).map((c) => [c.id, c]),
    );
    for (const thread of await this.api.activeThreads())
      channels.set(thread.id, thread);
    for (const parent of parents) {
      for (const thread of await this.archives(parent.id, since))
        channels.set(thread.id, thread);
    }
    const events: IncomingEvent[] = [];
    for (const channel of channels.values())
      events.push(...(await this.scanChannel(channel.id, since)));
    return { cursor: String(now), events };
  }
  private async archives(parent: string, since: number) {
    const threads = [];
    let before: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.api.archivedThreads(parent, before);
      threads.push(...result.threads);
      const next = result.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (!result.has_more || (next && Date.parse(next) < since))
        return threads;
      if (!next || next === before)
        throw Error("Discord archived thread pagination did not advance");
      before = next;
    }
    throw Error("Discord archived thread scan exceeded its safe page bound");
  }
  private async scanChannel(channel: string, since: number) {
    const events: IncomingEvent[] = [];
    let before: string | undefined;
    for (let page = 0; page < 100; page++) {
      const messages = await this.api.messages(channel, { before });
      for (const m of messages.filter((m) => this.relevant(m, since)))
        events.push(this.event(m));
      const oldest = messages.at(-1);
      if (
        messages.length < 100 ||
        (oldest && Date.parse(oldest.timestamp) < since)
      )
        return events;
      if (!oldest || oldest.id === before)
        throw Error("Discord message pagination did not advance");
      before = oldest.id;
    }
    throw Error("Discord message scan exceeded its safe page bound");
  }
  private relevant(m: DiscordMessage, since: number) {
    return (
      Date.parse(m.timestamp) >= since &&
      m.author.id !== this.api.settings.botId &&
      (m.type ?? 0) !== 7
    );
  }
  private event(m: DiscordMessage): IncomingEvent {
    return {
      source: this.source,
      id: m.channel_id + ":" + m.id,
      thread: m.channel_id,
      receivedAt: Date.parse(m.timestamp),
    };
  }
}
