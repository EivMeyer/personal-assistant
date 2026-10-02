import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureProcessedColumn,
  incomingPrompt,
  completeIncoming,
  nextIncomingBatch,
} from "./incoming-context.mjs";
const ctx = {
  agentId: "main",
  sessionKey: "agent:main:main:heartbeat",
  runId: "run",
};
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE events(source TEXT,id TEXT,thread TEXT,receivedAt INTEGER,detectedAt INTEGER,dispatchedAt INTEGER)",
  );
  ensureProcessedColumn(db);
  ensureProcessedColumn(db);
  db.exec(
    "INSERT INTO events VALUES('gmail-work','new-mail','thread-1',1,2,3,NULL)",
  );
  return db;
}
test("isolated heartbeat receives durable event details even after gateway accepted wake", (t) => {
  const db = setup(t);
  const batches = new Map();
  const p = incomingPrompt(db, ctx, batches);
  assert.match(p.prependContext, /SECRETARY_INCOMING_EVENTS/);
  assert.match(p.prependContext, /new-mail/);
  assert.match(p.prependContext, /Memory and task hygiene/);
  assert.match(p.prependContext, /Reconcile work completed outside Telegram/);
  assert.doesNotMatch(p.prependContext, /Follow HEARTBEAT.md's/);
  assert.equal(
    incomingPrompt(db, { ...ctx, sessionKey: "agent:main:main" }, batches),
    undefined,
  );
  assert.equal(
    incomingPrompt(db, { ...ctx, agentId: "other" }, batches),
    undefined,
  );
});
test("failed run leaves events pending and successful run acknowledges only its own batch", (t) => {
  const db = setup(t);
  const batches = new Map();
  incomingPrompt(db, ctx, batches);
  completeIncoming(db, { runId: "run", success: false }, ctx, batches);
  assert.equal(
    db.prepare("SELECT processedAt FROM events").get().processedAt,
    null,
  );
  db.exec("UPDATE incoming_attempts SET retryAt=0");
  incomingPrompt(db, ctx, batches);
  db.exec("INSERT INTO events VALUES('whatsapp','newer','chat',4,5,NULL,NULL)");
  completeIncoming(db, { runId: "run", success: true }, ctx, batches, {
    "gmail-work": { seen: ["new-mail"] },
  });
  assert.ok(
    db.prepare("SELECT processedAt FROM events WHERE id='new-mail'").get()
      .processedAt,
  );
  assert.equal(
    db.prepare("SELECT processedAt FROM events WHERE id='newer'").get()
      .processedAt,
    null,
  );
});

test("a media backlog cannot starve fresh messages from another source", (t) => {
  const db = setup(t);
  const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,NULL,NULL)");
  for (let i = 0; i < 30; i++)
    insert.run("whatsapp", "media-" + i, "chat", i, i);
  insert.run("slack", "Colleague", "dm", 100, 100);
  insert.run("gmail-personal", "personal", "thread", 101, 101);
  const first = nextIncomingBatch(db, 200);
  assert.equal(first.length, 4);
  assert.ok(first.find((item) => item.id === "Colleague"));
  assert.equal(new Set(first.slice(0, 4).map((item) => item.source)).size, 4);
  const second = nextIncomingBatch(db, 201);
  assert.ok(second.every((item) => !first.some((seen) => seen.id === item.id)));
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM events WHERE processedAt IS NOT NULL")
      .get().n,
    0,
  );
});

test("failed batches back off without delaying newly arrived messages", (t) => {
  const db = setup(t);
  const batches = new Map();
  const first = incomingPrompt(db, ctx, batches);
  assert.deepEqual(incomingPrompt(db, ctx, batches), first);
  completeIncoming(db, { success: false }, ctx, batches);
  assert.equal(nextIncomingBatch(db).length, 0);
  db.exec("INSERT INTO events VALUES('slack','new-reply','dm',4,5,NULL,NULL)");
  assert.deepEqual(
    nextIncomingBatch(db).map((item) => item.id),
    ["new-reply"],
  );
  assert.equal(
    db.prepare("SELECT processedAt FROM events WHERE id='new-mail'").get()
      .processedAt,
    null,
  );
  assert.equal(nextIncomingBatch(db, Date.now() + 901000).length, 2);
});

test("successful turn cannot acknowledge unread source events", (t) => {
  const db = setup(t);
  const batches = new Map();
  incomingPrompt(db, ctx, batches);
  completeIncoming(db, { runId: "run", success: true }, ctx, batches, {
    slack: { seen: ["different-message"] },
  });
  assert.equal(
    db.prepare("SELECT processedAt FROM events").get().processedAt,
    null,
  );
});

test("legacy Slack timestamp acknowledgements match routed channel-prefixed IDs", (t) => {
  const db = setup(t);
  db.exec(
    "INSERT INTO events VALUES('slack','D123:123.456','D123',4,5,NULL,NULL)",
  );
  const batches = new Map();
  incomingPrompt(db, ctx, batches);
  completeIncoming(db, { runId: "run", success: true }, ctx, batches, {
    slack: { seen: ["123.456"] },
  });
  assert.ok(
    db.prepare("SELECT processedAt FROM events WHERE source='slack'").get()
      .processedAt,
  );
  assert.equal(
    db.prepare("SELECT processedAt FROM events WHERE source='gmail-work'").get()
      .processedAt,
    null,
  );
});
