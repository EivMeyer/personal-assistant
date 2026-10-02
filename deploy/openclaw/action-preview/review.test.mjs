import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore } from "./action-store.mjs";
import { executeGuarded } from "./action-guard.mjs";
import { ReviewService } from "./review-service.mjs";
import { fixtureAction } from "./review-fixture.mjs";
import { authorizedQueueReview } from "./review-store.mjs";
const action = fixtureAction;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-review-test-")),
    path = join(dir, "actions.sqlite"),
    actions = new ActionStore(path);
  t.after(() => {
    actions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  let freshness = "initial";
  const rpc = async (method, params) => {
    calls.push({ method, params });
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
  return f.actions.reserve({
    server: action.server,
    name: action.tool,
    args,
    snapshot: [{ hash: "initial" }],
    runId: "fixture-run",
  });
}
function actionRow(f, id) {
  return f.actions.db.prepare("SELECT * FROM actions WHERE id=?").get(id);
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
  assert.equal(authorizedQueueReview(event, ctx, f.path), true);
  assert.equal(
    authorizedQueueReview(
      { ...event, params: { ...action.args, body: "Changed" } },
      ctx,
      f.path,
    ),
    false,
  );
  assert.equal(
    authorizedQueueReview(
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
  const result = actionRow(f, id);
  assert.equal(result.state, "completed");
  assert.match(
    JSON.parse(result.outcome).result.content[0].text,
    /Fixture accepted/,
  );
});
test("a reply arriving after approval blocks dispatch", async (t) => {
  const f = fixture(t),
    id = pending(f);
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
  assert.equal(actionRow(f, id).state, "blocked");
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
    f.actions.db.prepare("SELECT COUNT(*) AS n FROM actions").get().n,
    0,
  );
});
