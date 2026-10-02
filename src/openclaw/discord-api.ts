import { z } from "zod";
import type { Http } from "../http.ts";
import { discordHttp } from "./discord-http.ts";
export const discordId = z.string().regex(/^\d{17,20}$/);
export const discordSettings = z
  .object({
    tokenFile: z.string().min(1),
    botId: discordId,
    guildId: discordId,
    ownerId: discordId,
    channelIds: z.array(discordId).min(1).max(30),
  })
  .strict();
export type DiscordSettings = z.infer<typeof discordSettings>;
const channelSchema = z
  .object({
    id: discordId,
    guild_id: discordId.optional(),
    parent_id: discordId.nullable().optional(),
    type: z.number().int(),
    name: z.string().optional(),
    thread_metadata: z
      .object({ archive_timestamp: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const discordMessage = z
  .object({
    id: discordId,
    channel_id: discordId,
    timestamp: z.iso.datetime({ offset: true }),
    edited_timestamp: z.string().nullable().optional(),
    type: z.number().optional(),
    author: z
      .object({ id: discordId, bot: z.boolean().optional() })
      .passthrough(),
    content: z.string(),
    attachments: z.array(
      z
        .object({
          id: discordId,
          filename: z.string(),
          url: z.url(),
          size: z.number().nonnegative(),
          content_type: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type DiscordChannel = z.infer<typeof channelSchema>;
export type DiscordMessage = z.infer<typeof discordMessage>;
export class DiscordApi {
  readonly settings: DiscordSettings;
  private token: string;
  private http: Http;
  constructor(
    settings: DiscordSettings,
    token: string,
    http: Http = discordHttp,
  ) {
    this.settings = discordSettings.parse(settings);
    this.token = token.trim();
    this.http = http;
    if (!this.token) throw Error("Discord bot credential is missing");
  }
  private get(path: string) {
    return this.http("https://discord.com/api/v10/" + path, {
      method: "GET",
      headers: { Authorization: "Bot " + this.token },
    });
  }
  async verify() {
    const me = z
      .object({ id: discordId, bot: z.literal(true) })
      .parse(await this.get("users/@me"));
    if (me.id !== this.settings.botId)
      throw Error("Discord bot identity mismatch");
    const app = z
      .object({
        id: discordId,
        flags: z.number(),
        owner: z.object({ id: discordId }).optional(),
        team: z.object({ owner_user_id: discordId }).nullable().optional(),
      })
      .parse(await this.get("applications/@me"));
    if (
      app.id !== this.settings.botId ||
      !(app.flags & ((1 << 18) | (1 << 19)))
    )
      throw Error("Discord Message Content intent is required");
    if ((app.team?.owner_user_id ?? app.owner?.id) !== this.settings.ownerId)
      throw Error("Discord application owner mismatch");
  }
  async channel(id: string): Promise<DiscordChannel> {
    discordId.parse(id);
    const c = channelSchema.parse(await this.get(`channels/${id}`));
    const allowed =
      this.settings.channelIds.includes(c.id) ||
      ([10, 11, 12].includes(c.type) &&
        !!c.parent_id &&
        this.settings.channelIds.includes(c.parent_id));
    if (c.id !== id || c.guild_id !== this.settings.guildId || !allowed)
      throw Error(
        "Discord channel is outside the configured server/channel scope",
      );
    return c;
  }
  async channels() {
    const all = z
      .array(channelSchema)
      .parse(await this.get(`guilds/${this.settings.guildId}/channels`));
    const selected = all.filter((c) => this.settings.channelIds.includes(c.id));
    if (selected.length !== this.settings.channelIds.length)
      throw Error("A configured Discord channel is unavailable");
    return selected;
  }
  async messages(
    channel: string,
    query: { before?: string; around?: string } = {},
  ) {
    await this.channel(channel);
    const params = new URLSearchParams({ limit: "100" });
    for (const [key, value] of Object.entries(query))
      if (value) params.set(key, discordId.parse(value));
    if (query.before && query.around)
      throw Error("Use before or around, not both");
    const data = z
      .array(discordMessage)
      .parse(await this.get(`channels/${channel}/messages?${params}`));
    if (data.some((m) => m.channel_id !== channel))
      throw Error("Discord message channel mismatch");
    return data.sort((a, b) =>
      BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0,
    );
  }
  async message(channel: string, id: string) {
    await this.channel(channel);
    discordId.parse(id);
    const m = discordMessage.parse(
      await this.get(`channels/${channel}/messages/${id}`),
    );
    if (m.channel_id !== channel || m.id !== id)
      throw Error("Discord message identity mismatch");
    return m;
  }
  async activeThreads() {
    const result = z
      .object({ threads: z.array(channelSchema) })
      .parse(await this.get(`guilds/${this.settings.guildId}/threads/active`));
    return result.threads.filter(
      (c) => c.parent_id && this.settings.channelIds.includes(c.parent_id),
    );
  }
  async archivedThreads(parent: string, before?: string) {
    await this.channel(parent);
    if (!this.settings.channelIds.includes(parent))
      throw Error("Expected a configured parent channel");
    const query = new URLSearchParams({ limit: "100" });
    if (before)
      query.set("before", z.iso.datetime({ offset: true }).parse(before));
    const result = z
      .object({ threads: z.array(channelSchema), has_more: z.boolean() })
      .parse(
        await this.get(`channels/${parent}/threads/archived/public?${query}`),
      );
    if (result.threads.some((c) => c.parent_id !== parent))
      throw Error("Discord thread parent mismatch");
    return result;
  }
}
