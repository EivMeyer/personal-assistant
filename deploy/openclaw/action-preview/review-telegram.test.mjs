import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore } from "./action-store.mjs";
import { ReviewService } from "./review-service.mjs";
import { fixtureAction } from "./review-fixture.mjs";
import {
  handleButton,
  handleReply,
  itemMessage,
  syncQueue,
} from "./review-telegram.mjs";

const OWNER = "700000001";
const action = fixtureAction;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "secretary-queue-test-")),
    actions = new ActionStore(join(dir, "actions.sqlite"));
  t.after(() => {
    actions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const review = new ReviewService({
    actions,
    config: {},
    rpc: async (method, params) => {
      calls.push({ method, params });
      return { runId: "fixture-run" };
    },
    snapshot: async () => [{ hash: "initial" }],
  });
  const sent = [],
    edits = [];
  let nextId = 100,
    editError = null;
  const bot = {
    async send(message) {
      sent.push(message);
      return nextId++;
    },
    async edit(id, message) {
      if (editError) throw Error(editError);
      edits.push({ id, ...message });
    },
  };
  const captured = [];
  const sync = () =>
    syncQueue(review.store, bot, (text, id) => captured.push({ text, id }));
  return {
    review,
    calls,
    sent,
    edits,
    captured,
    sync,
    failEdits: (message) => (editError = message),
  };
}
function press(f, data, overrides = {}) {
  const replies = [];
  const [namespace, ...rest] = data.split(":");
  const ctx = {
    channel: "telegram",
    senderId: OWNER,
    isGroup: false,
    auth: { isAuthorizedSender: true },
    callback: { data, namespace, payload: rest.join(":") },
    respond: { reply: async ({ text }) => replies.push(text) },
    ...overrides,
  };
  return handleButton(ctx, f.review, OWNER, f.sync).then(() => replies);
}

test("a prepared action gets one message with the exact fields and buttons", async (t) => {
  const f = fixture(t);
  await f.review.propose({ key: "k1", title: "Reply to Ola", action });
  await f.sync();
  await f.sync();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /^Ready: Reply to Ola/);
  assert.match(f.sent[0].text, /To: recipient@example\.com/);
  assert.match(f.sent[0].text, /Message: Fictional message/);
  assert.doesNotMatch(f.sent[0].text, /secretary_sources|timeoutMs/);
  assert.deepEqual(
    f.sent[0].buttons[0].map((b) => b.text),
    ["Send…", "Set aside"],
  );
  for (const b of f.sent[0].buttons[0])
    assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  assert.equal(f.captured.length, 1);
});

test("state changes edit the same message and drop its buttons", async (t) => {
  const f = fixture(t);
  await f.review.propose({ key: "k1", title: "Reply to Ola", action });
  await f.sync();
  const [, setAside] = f.sent[0].buttons[0];
  await press(f, setAside.callback_data);
  assert.equal(f.sent.length, 1);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].id, 100);
  assert.match(f.edits[0].text, /^Set aside\. Nothing was sent: Reply to Ola/);
  assert.deepEqual(f.edits[0].buttons, []);
});

test("items that closed before being shown never reach the chat", async (t) => {
  const f = fixture(t);
  const item = await f.review.propose({ key: "k1", title: "Old", action });
  f.review.reject(item.id, item.version);
  await f.sync();
  assert.equal(f.sent.length, 0);
});

test("a deleted message is posted again instead of failing the queue", async (t) => {
  const f = fixture(t);
  const item = await f.review.propose({ key: "k1", title: "Reply", action });
  await f.sync();
  f.failEdits("Bad Request: message to edit not found");
  f.review.reject(item.id, item.version);
  await f.sync();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /^Set aside/);
});

test("Send… opens the native approval path and sends nothing itself", async (t) => {
  const f = fixture(t);
  await f.review.propose({ key: "k1", title: "Reply", action });
  await f.sync();
  const [open] = f.sent[0].buttons[0];
  assert.deepEqual(await press(f, open.callback_data), []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "chat.send");
  assert.equal(
    f.review.actions.db.prepare("SELECT COUNT(*) AS n FROM actions").get().n,
    0,
  );
  assert.match(f.edits.at(-1).text, /^Opening: Reply/);
  assert.deepEqual(f.edits.at(-1).buttons, []);
  // The old button carries a stale version and cannot open it again.
  const replies = await press(f, open.callback_data);
  assert.match(replies[0], /no longer ready/);
  assert.equal(f.calls.length, 1);
});

test("buttons from anyone but the owner do nothing", async (t) => {
  const f = fixture(t);
  await f.review.propose({ key: "k1", title: "Reply", action });
  await f.sync();
  const [open, setAside] = f.sent[0].buttons[0];
  await press(f, open.callback_data, { senderId: "700000002" });
  await press(f, setAside.callback_data, { isGroup: true });
  await press(f, setAside.callback_data, {
    auth: { isAuthorizedSender: false },
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.edits.length, 0);
});

test("replying to a question answers it; other replies go to the assistant", async (t) => {
  const f = fixture(t);
  await f.review.propose({
    key: "q1",
    title: "Lunch Friday",
    question: "Which timezone?",
  });
  await f.sync();
  assert.match(f.sent[0].text, /Reply to this message to answer/);
  const reply = (overrides) =>
    handleReply(
      {
        channel: "telegram",
        senderId: OWNER,
        replyToId: "100",
        content: "Pacific",
        ...overrides,
      },
      {},
      f.review,
      OWNER,
      f.sync,
    );
  assert.equal(await reply({ senderId: "700000002" }), undefined);
  assert.equal(await reply({ replyToId: "999" }), undefined);
  const claimed = await reply();
  assert.equal(claimed.handled, true);
  const [item] = f.review.store.list();
  assert.equal(item.state, "answered");
  assert.equal(item.answer, "Pacific");
  assert.equal(f.calls[0].method, "chat.send");
  assert.match(f.edits.at(-1).text, /You: Pacific/);
  // Already answered: a second reply is an ordinary message.
  assert.equal(await reply(), undefined);
});

test("long drafts are shortened in the chat, never in the action", () => {
  const body = "x".repeat(6000);
  const message = itemMessage({
    state: "ready",
    title: "Long",
    id: "00000000-0000-0000-0000-000000000000",
    version: 1,
    action: { ...action, args: { ...action.args, body } },
  });
  assert.ok(message.text.length < 4096);
  assert.match(message.text, /The approval shows all of it/);
});
