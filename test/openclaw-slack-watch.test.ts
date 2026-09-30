import assert from "node:assert/strict";
import test from "node:test";
import { SlackWatch } from "../src/openclaw/watch-slack.ts";
test("Slack combines DMs and mentions, deduplicates overlapping results, and excludes own posts", async () => {
  const now = Date.now();
  const queries: string[] = [];
  const http = async (url: string): Promise<unknown> => {
    if (url.includes("auth.test"))
      return { ok: true, user_id: "owner", team_id: "team" };
    queries.push(new URL(url).searchParams.get("query")!);
    return {
      ok: true,
      messages: {
        paging: { pages: 1 },
        matches: [
          { ts: String(now / 1000), user: "other", channel: { id: "C1" } },
          {
            ts: String((now - 100) / 1000),
            user: "owner",
            channel: { id: "C1" },
          },
          { ts: "1.0", user: "other", channel: { id: "C1" } },
        ],
      },
    };
  };
  const result = await new SlackWatch(
    "fake",
    { user: "owner", team: "team" },
    now - 1000,
    http,
  ).scan();
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.thread, "C1");
  assert.equal(queries.length, 2);
  assert.ok(queries.some((q) => q.startsWith("to:me")));
  assert.ok(queries.some((q) => q.startsWith("<@owner>")));
});
test("Slack rejects failed API response rather than advancing a checkpoint", async () => {
  const http = async (url: string): Promise<unknown> =>
    url.includes("auth.test")
      ? { ok: true, user_id: "owner", team_id: "team" }
      : { ok: false, error: "ratelimited" };
  const watch = new SlackWatch(
    "fake",
    { user: "owner", team: "team" },
    0,
    http,
  );
  await assert.rejects(watch.scan());
});
