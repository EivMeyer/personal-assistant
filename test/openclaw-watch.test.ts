import assert from "node:assert/strict";
import test from "node:test";
import { WatchStore } from "../src/openclaw/watch-store.ts";
import { GmailWatch } from "../src/openclaw/watch-gmail.ts";
import {
  dispatchPending,
  pollDetector,
  repeat,
} from "../src/openclaw/watch-loop.ts";
import { ApiError } from "../src/http.ts";
const event = {
  source: "gmail-work",
  id: "incoming",
  thread: "thread",
  receivedAt: 10,
};
test("watch retries report safe failure categories and confirm recovery", async () => {
  const abort = new AbortController();
  const logs: Record<string, unknown>[] = [];
  let calls = 0;
  await repeat(
    async () => {
      if (!calls++)
        throw new TypeError("secret token in URL", {
          cause: { code: "ENETUNREACH" },
        });
      abort.abort();
    },
    1,
    abort.signal,
    (entry) => logs.push(entry),
  );
  assert.equal(logs[0]?.event, "watch_retry");
  assert.equal(logs[0]?.code, "ENETUNREACH");
  assert.equal(logs[1]?.event, "watch_recovered");
  assert.ok(!JSON.stringify(logs).includes("secret"));
});
test("intentional watcher shutdown is not reported as a source failure", async () => {
  const abort = new AbortController();
  const logs: unknown[] = [];
  await repeat(
    async () => {
      abort.abort();
      throw Error("cancelled");
    },
    1,
    abort.signal,
    (entry) => logs.push(entry),
  );
  assert.deepEqual(logs, []);
});
test("watcher atomically deduplicates events and preserves pending wake across failed dispatch", async () => {
  const store = new WatchStore(":memory:");
  try {
    store.ingest(event.source, "1", [event], 20);
    store.ingest(event.source, "2", [event], 30);
    await assert.rejects(
      dispatchPending(store, async () => {
        throw Error("offline");
      }),
    );
    assert.equal(store.pending().length, 1);
    let wakes = 0;
    await dispatchPending(store, async () => {
      wakes++;
    });
    await dispatchPending(store, async () => {
      wakes++;
    });
    assert.equal(wakes, 1);
    assert.equal(store.checkpoint(event.source)?.cursor, "2");
  } finally {
    store.db.close();
  }
});
test("failed source scan cannot advance its cursor", async () => {
  const store = new WatchStore(":memory:");
  try {
    store.ingest(event.source, "before", [], 20);
    await assert.rejects(
      pollDetector(
        {
          source: event.source,
          scan: async () => {
            throw Error("offline");
          },
        },
        store,
      ),
    );
    assert.equal(store.checkpoint(event.source)?.cursor, "before");
  } finally {
    store.db.close();
  }
});
test("Gmail detects added incoming mail through history and excludes sent mail", async () => {
  const client = {
    request: async (path: string): Promise<unknown> => {
      if (path === "profile")
        return { emailAddress: "owner@example.com", historyId: "2" };
      if (path.startsWith("history?"))
        return {
          historyId: "3",
          history: [
            {
              messagesAdded: [
                { message: { id: "in" } },
                { message: { id: "out" } },
              ],
            },
          ],
        };
      return {
        id: path.includes("/in?") ? "in" : "out",
        threadId: "t",
        internalDate: "123",
        labelIds: path.includes("/in?") ? ["INBOX"] : ["SENT"],
      };
    },
  };
  const watch = new GmailWatch("gmail-work", client, "owner@example.com", 0);
  const result = await watch.scan({ cursor: "2", checkedAt: 100 });
  assert.deepEqual(
    result.events.map((e) => e.id),
    ["in"],
  );
  assert.equal(result.cursor, "3");
});
test("expired Gmail history recovers from persisted checkpoint with overlap", async () => {
  const paths: string[] = [];
  const client = {
    request: async (path: string): Promise<unknown> => {
      paths.push(path);
      if (path === "profile")
        return { emailAddress: "owner@example.com", historyId: "new" };
      if (path.startsWith("history?")) throw new ApiError("gmail", 404);
      return { messages: [] };
    },
  };
  const result = await new GmailWatch(
    "gmail-work",
    client,
    "owner@example.com",
    0,
  ).scan({ cursor: "old", checkedAt: 300000 });
  assert.equal(result.cursor, "new");
  assert.ok(paths.some((p) => decodeURIComponent(p).includes("after:180")));
});
test("wrong Gmail identity fails before reading history", async () => {
  const watch = new GmailWatch(
    "gmail-work",
    {
      request: async () => ({
        emailAddress: "wrong@example.com",
        historyId: "1",
      }),
    },
    "owner@example.com",
    0,
  );
  await assert.rejects(watch.scan(), /differs/);
});

test("accepted wakes retry until the isolated run acknowledges processing", () => {
  const store = new WatchStore(":memory:");
  try {
    store.ingest(event.source, "1", [event], 20);
    store.dispatched([event], 100);
    assert.equal(store.pending(200).length, 0);
    assert.equal(store.pending(60101).length, 1);
    store.db.prepare("UPDATE events SET processedAt=60102").run();
    assert.equal(store.pending(120200).length, 0);
  } finally {
    store.db.close();
  }
});

test("staggered retries coalesce while newly arrived messages still wake immediately", () => {
  const store = new WatchStore(":memory:");
  try {
    store.ingest(event.source, "1", [event], 1);
    store.dispatched([event], 100);
    const second = { ...event, id: "second" };
    store.ingest(event.source, "2", [second], 30000);
    assert.deepEqual(
      store.pending(30000).map((item) => item.id),
      ["second"],
    );
    store.dispatched([second], 30000);
    assert.equal(store.pending(60101).length, 0);
    assert.equal(store.pending(90001).length, 2);
  } finally {
    store.db.close();
  }
});

test("leased and failed reads do not wake repeatedly or suppress fresh arrivals", () => {
  const store = new WatchStore(":memory:");
  try {
    store.ingest(event.source, "1", [event], 1);
    store.db
      .prepare("INSERT INTO incoming_attempts VALUES(?,?,1,10,300010)")
      .run(event.source, event.id);
    assert.equal(store.pending(70000).length, 0);
    const fresh = { ...event, id: "fresh" };
    store.ingest(event.source, "2", [fresh], 70000);
    assert.deepEqual(
      store.pending(70000).map((item) => item.id),
      ["fresh"],
    );
    assert.equal(store.pending(300011).length, 2);
  } finally {
    store.db.close();
  }
});

test("a scan delayed by sleep or network saves its start time, so the next scan cannot skip the gap", async (t) => {
  const store = new WatchStore(":memory:");
  t.after(() => store.db.close());
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => clock);
  await pollDetector(
    {
      source: "slack",
      scan: async () => {
        clock += 600_000;
        return { cursor: "scan-start", events: [] };
      },
    },
    store,
  );
  assert.equal(store.checkpoint("slack")?.checkedAt, 1_000_000);
  const gapMessage = { ...event, source: "slack", receivedAt: 1_100_000 };
  await pollDetector(
    {
      source: "slack",
      scan: async (checkpoint) => ({
        cursor: "resumed",
        events:
          gapMessage.receivedAt >= checkpoint!.checkedAt - 120_000
            ? [gapMessage]
            : [],
      }),
    },
    store,
  );
  assert.deepEqual(
    store.pending().map((item) => item.id),
    [gapMessage.id],
  );
});
