import test from "node:test";
import assert from "node:assert/strict";
import {
  DiscordApi,
  type DiscordSettings,
} from "../src/openclaw/discord-api.ts";
import { DiscordWatch } from "../src/openclaw/watch-discord.ts";
import { discordTransport } from "../src/openclaw/discord-http.ts";
import { WatchStore } from "../src/openclaw/watch-store.ts";
import { pollDetector } from "../src/openclaw/watch-loop.ts";
const guild = "11111111111111111",
  channel = "22222222222222222",
  bot = "33333333333333333",
  owner = "44444444444444444",
  thread = "55555555555555555";
const settings: DiscordSettings = {
  guildId: guild,
  botId: bot,
  ownerId: owner,
  channelIds: [channel],
  tokenFile: "/fixture-only",
};
const msg = (id: string, at: string, ch = channel) => ({
  id,
  channel_id: ch,
  timestamp: at,
  content: "fixture",
  attachments: [],
  author: { id: owner },
  type: 0,
});
function apiFixture(overrides: (path: string) => unknown = () => undefined) {
  const calls: string[] = [];
  const api = new DiscordApi(settings, "fixture-secret", async (url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bot fixture-secret",
    );
    const path = url.replace("https://discord.com/api/v10/", "");
    calls.push(path);
    const custom = overrides(path);
    if (custom !== undefined) return custom;
    if (path === "users/@me") return { id: bot, bot: true };
    if (path === "applications/@me")
      return { id: bot, flags: 1 << 19, owner: { id: owner } };
    if (path === `guilds/${guild}/channels`)
      return [{ id: channel, guild_id: guild, type: 0 }];
    if (path === `guilds/${guild}/threads/active`) return { threads: [] };
    if (path === `channels/${channel}`)
      return { id: channel, guild_id: guild, type: 0 };
    if (path.includes("threads/archived"))
      return { threads: [], has_more: false };
    return [];
  });
  return { api, calls };
}
test("Discord reader rejects wrong bots, missing content intent and out-of-scope channels before reading messages", async () => {
  for (const override of [
    (p: string) => (p === "users/@me" ? { id: owner, bot: true } : undefined),
    (p: string) =>
      p === "applications/@me" ? { id: bot, flags: 0 } : undefined,
  ])
    await assert.rejects(apiFixture(override).api.verify());
  const { api, calls } = apiFixture((p) =>
    p === `channels/${thread}`
      ? {
          id: thread,
          type: 11,
          guild_id: "66666666666666666",
          parent_id: channel,
        }
      : undefined,
  );
  await assert.rejects(api.messages(thread), /scope/);
  assert.ok(!calls.some((p) => p.includes("messages")));
  await assert.rejects(api.message("../users", owner));
});
test("Discord watcher paginates without gaps, includes owner replies, deduplicates overlap, and ignores join messages", async () => {
  const recent = new Date().toISOString();
  const old = "2020-01-01T00:00:00Z";
  const first = Array.from({ length: 100 }, (_, i) =>
    msg(String(90000000000000100n - BigInt(i)), recent),
  );
  const { api } = apiFixture((p) => {
    if (p.includes("/messages?"))
      return p.includes("before=")
        ? [
            msg("89999999999999999", recent),
            msg("89999999999999998", old),
            { ...msg("89999999999999997", recent), type: 7 },
          ]
        : first;
    return undefined;
  });
  const store = new WatchStore(":memory:");
  try {
    const watch = new DiscordWatch(api, Date.now() - 60000);
    assert.equal(await pollDetector(watch, store), 101);
    assert.equal(await pollDetector(watch, store), 0);
    assert.equal(store.pending().length, 20);
  } finally {
    store.db.close();
  }
});
test("Discord discovers active and archived public threads including forum posts", async () => {
  const other = "66666666666666666";
  const { api, calls } = apiFixture((p) => {
    if (p === `guilds/${guild}/channels`)
      return [{ id: channel, guild_id: guild, type: 15 }];
    if (p === `guilds/${guild}/threads/active`)
      return {
        threads: [
          { id: thread, guild_id: guild, parent_id: channel, type: 11 },
        ],
      };
    if (p.includes("/threads/archived/"))
      return {
        threads: [{ id: other, guild_id: guild, parent_id: channel, type: 11 }],
        has_more: false,
      };
    if ([`channels/${thread}`, `channels/${other}`].includes(p))
      return {
        id: p.split("/")[1],
        guild_id: guild,
        parent_id: channel,
        type: 11,
      };
    if (p.includes("/messages?"))
      return [
        msg("77777777777777777", new Date().toISOString(), p.split("/")[1]),
      ];
    return undefined;
  });
  const result = await new DiscordWatch(api, Date.now() - 60000).scan();
  assert.deepEqual(
    new Set(result.events.map((e) => e.thread)),
    new Set([thread, other]),
  );
  assert.ok(!calls.some((p) => p.startsWith(`channels/${channel}/messages`)));
});
test("Discord failed scan retains the durable checkpoint", async () => {
  const { api } = apiFixture((p) => {
    if (p.includes("/messages?")) throw Error("offline");
  });
  const store = new WatchStore(":memory:");
  try {
    store.ingest("discord", "old", [], 10);
    await assert.rejects(pollDetector(new DiscordWatch(api, 0), store));
    assert.equal(store.checkpoint("discord")?.cursor, "old");
  } finally {
    store.db.close();
  }
});
test("Discord rate-limit cooldown prevents requests until Discord's retry-after expires", async () => {
  let now = 0,
    calls = 0;
  const request = discordTransport(
    (async () => {
      calls++;
      return new Response(JSON.stringify({ retry_after: 120 }), {
        status: 429,
      });
    }) as typeof fetch,
    () => now,
  );
  await assert.rejects(
    request("https://discord.com/api/v10/users/@me"),
    (e) => (e as { retryAfterMs: number }).retryAfterMs === 120000,
  );
  now = 60000;
  await assert.rejects(request("https://discord.com/api/v10/users/@me"));
  assert.equal(calls, 1);
  now = 120001;
  await assert.rejects(request("https://discord.com/api/v10/users/@me"));
  assert.equal(calls, 2);
});
