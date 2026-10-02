import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore, splitCapture } from "./inbox-store.mjs";
import { createInboxServer } from "./inbox-server.mjs";
import { registerInbox } from "./inbox.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "secretary-inbox-test-"));
  const store = new InboxStore(
    join(home, ".local/share/secretary-inbox/inbox.sqlite"),
  );
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, store };
}
test("batch capture is atomic, idempotent, durable and preserves original notes", (t) => {
  const { home, store } = fixture(t);
  assert.deepEqual(splitCapture("- First\n2. Second\n\n• Third"), [
    "First",
    "Second",
    "Third",
  ]);
  const rows = store.capture("First\nSecond", "web", "capture-1");
  assert.equal(rows.length, 2);
  assert.deepEqual(store.capture("First\nSecond", "web", "capture-1"), rows);
  assert.throws(
    () => store.capture("Different", "web", "capture-1"),
    /different note/,
  );
  assert.throws(() => store.capture("A\n".repeat(51), "web"), /50 items/);
  const reopened = new InboxStore(
    join(home, ".local/share/secretary-inbox/inbox.sqlite"),
  );
  assert.equal(reopened.list().length, 2);
  reopened.close();
});
test("stale cross-channel updates cannot overwrite owner edits or count as approval", (t) => {
  const { store } = fixture(t);
  let [row] = store.capture("Draft meeting reply", "web");
  row = store.update(row.id, row.version, { status: "queued" });
  const [claimed] = store.claim("run-a");
  const edited = store.update(claimed.id, claimed.version, {
    title: "Updated request",
    status: "inbox",
  });
  assert.throws(
    () =>
      store.update(
        row.id,
        claimed.version,
        { status: "ready", draft: "Old draft" },
        "assistant",
        "run-a",
      ),
    /changed/,
  );
  assert.throws(
    () => store.update(row.id, edited.version, { status: "approved" }),
    /Invalid task status/,
  );
  assert.equal(store.get(row.id).title, "Updated request");
});
test("preparation leases fail closed on interruption and wrong run", (t) => {
  const { store } = fixture(t);
  const [row] = store.capture("Prepare notes", "telegram");
  store.update(row.id, row.version, { status: "queued" });
  const [claimed] = store.claim("run-a");
  assert.throws(
    () =>
      store.update(
        row.id,
        claimed.version,
        { status: "ready", draft: "Hello" },
        "assistant",
        "run-b",
      ),
    /lease/,
  );
  store.recover("run-a");
  assert.equal(store.get(row.id).status, "needs_info");
  assert.match(store.get(row.id).draft, /stopped/);
});
async function serverFixture(t) {
  const f = fixture(t);
  const server = createInboxServer({
    store: f.store,
    token: "a".repeat(64),
    notes: () => "Private notes",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", data, headers = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(method !== "GET"
          ? { "Content-Type": "application/json", Origin: origin }
          : {}),
        ...headers,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const login = await request("/api/session", "POST", {
    token: "a".repeat(64),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { ...f, origin, request, cookie };
}
test("HTTP inbox rejects unauthenticated, cross-origin and DNS-rebound access", async (t) => {
  const { request, cookie } = await serverFixture(t);
  assert.equal((await request("/api/tasks")).status, 401);
  assert.equal(
    (
      await request("/api/notes", "GET", null, {
        Cookie: cookie,
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const { origin } = await serverFixture(t);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      origin + "/api/tasks",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(
    (
      await request(
        "/api/tasks",
        "POST",
        { text: "bad" },
        { Cookie: cookie, Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const result = await request("/api/tasks", "GET", null, { Cookie: cookie });
  assert.equal(result.status, 200);
  assert.match(
    (await request("/")).headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});
test("web and verified Telegram commands share the same durable queue", async (t) => {
  const { home, request, cookie } = await serverFixture(t);
  const commands = new Map();
  let service;
  registerInbox(
    {
      registerService: (s) => (service = s),
      registerCommand: (c) => commands.set(c.name, c),
      registerTool: () => {},
      on: () => {},
      runtime: { system: { requestHeartbeat: () => {} } },
    },
    { home },
  );
  t.after(() => service.stop());
  const ctx = {
    channel: "telegram",
    senderId: "700000001",
    isAuthorizedSender: true,
    args: "From Telegram\nAnother task",
  };
  assert.match(
    commands.get("capture").handler({ ...ctx, senderId: "700000002" }).text,
    /verified Telegram owner/,
  );
  assert.match(commands.get("capture").handler(ctx).text, /Added/);
  let result = await (
    await request("/api/tasks", "GET", null, { Cookie: cookie })
  ).json();
  assert.equal(result.tasks.length, 2);
  const added = await request(
    "/api/tasks",
    "POST",
    { text: "From Mac", key: "web-capture" },
    { Cookie: cookie },
  );
  assert.equal(added.status, 201);
  assert.match(
    commands.get("inbox").handler({ ...ctx, args: "tasks" }).text,
    /From Mac/,
  );
  const row = result.tasks[0];
  commands.get("inbox").handler({ ...ctx, args: "done " + row.id.slice(0, 8) });
  result = await (
    await request("/api/tasks", "GET", null, { Cookie: cookie })
  ).json();
  assert.equal(result.tasks.find((r) => r.id === row.id).status, "done");
});
test("draft tool requires the owning heartbeat session and honors changed revisions", async (t) => {
  const { home, store } = fixture(t);
  let service, factory;
  const hooks = new Map();
  registerInbox(
    {
      registerService: (s) => (service = s),
      registerCommand: () => {},
      registerTool: (f) => (factory = f),
      on: (n, h) => hooks.set(n, h),
      runtime: { system: { requestHeartbeat: () => {} } },
    },
    { home },
  );
  t.after(() => service.stop());
  const [row] = store.capture("Prepare a fictional draft", "web");
  store.update(row.id, row.version, { status: "queued" });
  const ctx = {
    agentId: "main",
    sessionKey: "agent:main:main:heartbeat",
    sessionId: "session-a",
    runId: "run-a",
  };
  assert.match(
    hooks.get("before_prompt_build")({}, ctx).prependContext,
    /SECRETARY_DRAFT_TASKS/,
  );
  const claimed = store.get(row.id);
  const params = {
    operation: "finish",
    id: row.id,
    version: claimed.version,
    status: "ready",
    draft: "Fictional draft",
  };
  assert.equal(
    factory({
      agentId: "main",
      messageChannel: "telegram",
      requesterSenderId: "wrong",
      senderIsOwner: true,
    }),
    null,
  );
  await assert.rejects(
    factory({ ...ctx, sessionId: "session-b" }).execute("tool", params),
    /No active preparation/,
  );
  await factory(ctx).execute("tool", params);
  assert.equal(store.get(row.id).status, "ready");
  hooks.get("agent_end")({ success: true }, ctx);
  assert.equal(store.get(row.id).status, "ready");
});
