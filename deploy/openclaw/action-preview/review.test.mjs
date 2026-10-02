import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, actionKey } from "./action-store.mjs";
import { executeGuarded } from "./action-guard.mjs";
import { ReviewService } from "./review-service.mjs";
import { authorizedWebReview } from "./review-store.mjs";
import { reviewHttp } from "./review-http.mjs";
const action = {
  server: "gmail-work-actions",
  tool: "send_email",
  args: {
    to: ["recipient@example.com"],
    subject: "Fixture",
    body: "Fictional message",
    secretary_sources: [],
    timeoutMs: 210000,
  },
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-review-test-")),
    path = join(dir, "actions.sqlite"),
    actions = new ActionStore(path);
  t.after(() => {
    actions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [],
    approvals = [];
  let freshness = "initial";
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "plugin.approval.list") return structuredClone(approvals);
    if (method === "plugin.approval.resolve") {
      const i = approvals.findIndex((a) => a.id === params.id);
      if (i < 0) throw Error("Already resolved elsewhere");
      approvals.splice(i, 1);
      return { ok: true };
    }
    return { runId: "fixture-run", status: "started" };
  };
  const review = new ReviewService({
    actions,
    config: {},
    rpc,
    snapshot: async () => [{ hash: freshness }],
  });
  return {
    review,
    actions,
    calls,
    approvals,
    path,
    changeSource: () => (freshness = "changed"),
  };
}
async function staged(f, key = "fixture") {
  return f.review.propose({
    key,
    title: "Reply to the fixture",
    action: structuredClone(action),
  });
}
function pending(f, args = action.args) {
  const id = f.actions.reserve({
    server: action.server,
    name: action.tool,
    args,
    snapshot: [{ hash: "initial" }],
    runId: "fixture-run",
  });
  f.approvals.push({
    id: "plugin:fixture",
    expiresAtMs: Date.now() + 120000,
    request: {
      runId: "fixture-run",
      mcpTool: { server: action.server, tool: action.tool },
      allowedDecisions: ["allow-once", "deny"],
    },
  });
  return id;
}
async function decision(f, id, choice = "allow-once") {
  const row = (await f.review.list()).actions.find((a) => a.id === id);
  return {
    id,
    approvalId: row.approvalId,
    reviewToken: row.reviewToken,
    decision: choice,
  };
}
test("opening an exact review requests a native approval without executing", async (t) => {
  const f = fixture(t),
    item = await staged(f);
  const opened = await f.review.open(item.id, item.version);
  assert.equal(opened.state, "opening");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "chat.send");
  assert.equal(
    f.actions.db.prepare("SELECT COUNT(*) AS n FROM actions").get().n,
    0,
  );
  const ctx = {
    requester: { channel: "webchat", senderIsOwner: true },
    sessionKey: opened.sessionKey,
  };
  const event = {
    toolName: "mcp__gmail-work-actions__send_email",
    params: action.args,
  };
  assert.equal(authorizedWebReview(event, ctx, f.path), true);
  assert.equal(
    authorizedWebReview(
      { ...event, params: { ...action.args, body: "Changed" } },
      ctx,
      f.path,
    ),
    false,
  );
  assert.equal(
    authorizedWebReview(
      event,
      { ...ctx, requester: { channel: "webchat", senderIsOwner: false } },
      f.path,
    ),
    false,
  );
});
test("source changes before opening block preparation", async (t) => {
  const f = fixture(t),
    item = await staged(f);
  f.changeSource();
  await assert.rejects(
    f.review.open(item.id, item.version),
    /conversation changed/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.review.store.get(item.id).state, "needs_info");
});
test("one approval executes once and history comes from the connector receipt", async (t) => {
  const f = fixture(t),
    id = pending(f);
  await f.review.resolve(await decision(f, id));
  let sent = 0;
  const options = {
    server: action.server,
    name: action.tool,
    args: action.args,
    config: {},
    store: f.actions,
    snapshot: async () => [{ hash: "initial" }],
    invoke: async () => {
      sent++;
      return { content: [{ type: "text", text: "Fixture accepted" }] };
    },
  };
  await executeGuarded(options);
  assert.equal(sent, 1);
  await assert.rejects(executeGuarded(options), /consumed/);
  assert.equal(sent, 1);
  const result = (await f.review.list()).actions.find((a) => a.id === id);
  assert.equal(result.state, "completed");
  assert.match(result.outcome.result.content[0].text, /Fixture accepted/);
});
test("a reply arriving after approval blocks dispatch", async (t) => {
  const f = fixture(t),
    id = pending(f);
  await f.review.resolve(await decision(f, id));
  let sent = 0;
  await executeGuarded({
    server: action.server,
    name: action.tool,
    args: action.args,
    config: {},
    store: f.actions,
    snapshot: async () => [{ hash: "new reply" }],
    invoke: async () => {
      sent++;
    },
  });
  assert.equal(sent, 0);
  assert.equal(
    (await f.review.list()).actions.find((a) => a.id === id).state,
    "blocked",
  );
});
test("unmatched and stale native approval tickets cannot authorize an action", async (t) => {
  const f = fixture(t),
    id = pending(f);
  const p = await decision(f, id);
  await assert.rejects(
    f.review.resolve({ ...p, reviewToken: "forged" }),
    /exact approval changed/,
  );
  f.approvals[0].request.mcpTool.tool = "delete_email";
  await assert.rejects(f.review.resolve(p), /exact approval changed/);
  assert.equal(
    f.calls.filter((c) => c.method === "plugin.approval.resolve").length,
    0,
  );
});
test("a Telegram decision makes the web copy non-executable", async (t) => {
  const f = fixture(t),
    id = pending(f);
  const p = await decision(f, id);
  f.approvals.length = 0;
  await assert.rejects(f.review.resolve(p), /exact approval changed/);
  assert.equal(
    (await f.review.list()).actions.find((a) => a.id === id).canApprove,
    false,
  );
});
test("editing rejects the old native action and creates an unapproved revision", async (t) => {
  const f = fixture(t),
    id = pending(f);
  const p = await decision(f, id);
  const revised = {
    ...action,
    args: { ...action.args, body: "Edited fictional message" },
  };
  const next = await f.review.revise({
    ...p,
    action: revised,
    title: "Edited reply",
  });
  assert.equal(next.state, "ready");
  assert.equal(next.action.args.body, revised.args.body);
  assert.notEqual(
    next.fingerprint,
    actionKey(action.server, action.tool, action.args),
  );
  assert.equal(
    f.actions.db.prepare("SELECT state FROM actions WHERE id=?").get(id).state,
    "rejected",
  );
  await assert.rejects(f.review.resolve(p), /no longer awaiting approval/);
});
test("answering a question creates a draftable item without approving it", async (t) => {
  const f = fixture(t);
  const question = await f.review.propose({
    key: "question-1",
    title: "Choose meeting time",
    question: "Tuesday or Thursday?",
  });
  await f.review.answer(question.id, question.version, "Thursday");
  const next = await f.review.propose({
    key: "question-1",
    title: "Meeting reply",
    action,
  });
  assert.equal(next.id, question.id);
  assert.equal(next.state, "ready");
  assert.equal(next.answer, "Thursday");
  assert.equal(
    f.calls.filter((c) => c.method === "plugin.approval.resolve").length,
    0,
  );
});
test("HTTP review decisions use the same service and reject unknown routes", async (t) => {
  const f = fixture(t),
    id = pending(f);
  const p = await decision(f, id);
  let response;
  const handled = await reviewHttp(
    {
      req: { method: "POST" },
      path: "/api/reviews/decision",
      reply: (status, data) => (response = { status, data }),
    },
    async () => p,
    f.review,
  );
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(
    await reviewHttp(
      { req: { method: "POST" }, path: "/api/reviews/arbitrary" },
      async () => ({}),
      f.review,
    ),
    false,
  );
});
