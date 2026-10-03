import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readMessages, readMessageText } from "./whatsapp-read.mjs";
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE messages (id TEXT,chat_jid TEXT,sender TEXT,content TEXT,timestamp TEXT,is_from_me INTEGER,media_type TEXT,filename TEXT);
    INSERT INTO messages VALUES ('one','chat','sender','first','2026-09-25 08:00:00+02:00',0,'',''),
      ('two','chat','owner','second','2026-09-25 08:01:00+02:00',1,'',''),
      ('three','other','sender','third','2026-09-25 08:02:00+02:00',0,'','');`);
  return db;
}
test("WhatsApp reads preserve IDs, UTC timestamps, own-message flags and pagination", (t) => {
  const db = setup(t);
  const first = readMessages(db, { chat_jid: "chat", limit: 1 });
  assert.equal(first.messages[0].id, "two");
  assert.equal(first.messages[0].is_from_me, true);
  assert.equal(first.messages[0].timestamp_utc, "2026-09-25T06:01:00.000Z");
  assert.equal(first.next_offset, 1);
  const next = readMessages(db, {
    chat_jid: "chat",
    limit: 1,
    offset: first.next_offset,
  });
  assert.equal(next.messages[0].id, "one");
  assert.equal(next.next_offset, null);
  assert.deepEqual(
    readMessages(db, { after: "2026-09-25T06:02:00Z" }).messages.map(
      (x) => x.id,
    ),
    ["three"],
  );
});
test("ambiguous time and unsafe pagination fail instead of returning a misleading empty scan", (t) => {
  const db = setup(t);
  assert.throws(
    () => readMessages(db, { after: "2026-09-25 08:00" }),
    /timezone/,
  );
  assert.throws(() => readMessages(db, { limit: 101 }), /limit/);
  assert.throws(() => readMessages(db, { offset: -1 }), /offset/);
});

test("exact-message context jumps into a busy chat and expands without gaps", (t) => {
  const db = setup(t);
  const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 1000; i++)
    insert.run(
      "m" + String(i).padStart(4, "0"),
      "busy",
      "sender",
      "message " + i,
      "2026-10-01T12:00:00Z",
      i % 2,
      "",
      "",
    );
  const around = readMessages(db, {
    chat_jid: "busy",
    message_id: "m0500",
    limit: 2,
  });
  assert.deepEqual(
    around.messages.map((m) => m.id),
    ["m0498", "m0499", "m0500", "m0501", "m0502"],
  );
  assert.equal(around.messages[1].is_from_me, true);
  assert.equal(around.messages[2].timestamp_utc, "2026-10-01T12:00:00.000Z");
  const older = readMessages(db, {
    chat_jid: "busy",
    ...around.older,
    limit: 2,
  });
  assert.deepEqual(
    older.messages.map((m) => m.id),
    ["m0496", "m0497"],
  );
  const newer = readMessages(db, {
    chat_jid: "busy",
    ...around.newer,
    limit: 2,
  });
  assert.deepEqual(
    newer.messages.map((m) => m.id),
    ["m0503", "m0504"],
  );
  assert.equal(
    readMessages(db, { chat_jid: "busy", message_id: "m0000", limit: 2 }).older,
    null,
  );
  assert.equal(
    readMessages(db, { chat_jid: "busy", message_id: "m0999", limit: 2 }).newer,
    null,
  );
  const end = readMessages(db, {
    chat_jid: "busy",
    message_id: "m0998",
    direction: "after",
    limit: 2,
  });
  assert.deepEqual(
    end.messages.map((m) => m.id),
    ["m0999"],
  );
  assert.equal(end.newer, null);
});
test("context fails closed for a missing or wrong-chat ID and incompatible scan arguments", (t) => {
  const db = setup(t);
  assert.throws(() => readMessages(db, { message_id: "one" }), /chat_jid/);
  for (const message_id of ["", null, 123])
    assert.throws(
      () => readMessages(db, { chat_jid: "chat", message_id }),
      /chat_jid/,
    );
  assert.throws(
    () => readMessages(db, { chat_jid: "other", message_id: "one" }),
    /not found/,
  );
  assert.throws(
    () => readMessages(db, { chat_jid: "chat", message_id: "missing" }),
    /not found/,
  );
  for (const extra of [{ after: "2026-09-25T06:00:00Z" }, { offset: 0 }])
    assert.throws(
      () => readMessages(db, { chat_jid: "chat", message_id: "one", ...extra }),
      /not after\/offset/,
    );
  assert.throws(
    () =>
      readMessages(db, {
        chat_jid: "chat",
        message_id: "one",
        direction: "invalid",
      }),
    /direction/,
  );
  assert.throws(
    () => readMessages(db, { direction: "after" }),
    /requires message_id/,
  );
});
test("context orders mixed timezone timestamps by instant and preserves exact quoted content", (t) => {
  const db = setup(t);
  db.exec(
    "INSERT INTO messages VALUES ('earlier','chat','sender','quoted source','2026-09-25T08:59:00+03:00',0,'image','x.jpg')",
  );
  const result = readMessages(db, {
    chat_jid: "chat",
    message_id: "one",
    limit: 1,
  });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["earlier", "one", "two"],
  );
  assert.equal(result.messages[0].content, "quoted source");
  assert.equal(result.messages[0].media_type, "image");
  assert.equal(result.older, null);
  assert.equal(result.newer, null);
});

test("oversized WhatsApp pages remain valid and continuations lose no messages or text", (t) => {
  const db = setup(t);
  const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)");
  const body = '"\n😀'.repeat(2500);
  for (let i = 0; i < 30; i++)
    insert.run(
      "large" + i,
      "large-chat",
      "sender",
      body,
      "2026-10-01T12:00:00Z",
      0,
      "",
      "",
    );
  let offset = 0;
  const ids = [];
  do {
    const page = readMessages(db, {
      chat_jid: "large-chat",
      limit: 100,
      offset,
    });
    assert.ok(JSON.stringify(page).length < 48000);
    ids.push(...page.messages.map((m) => m.id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 30);
  const around = readMessages(db, {
    chat_jid: "large-chat",
    message_id: "large15",
    limit: 100,
  });
  assert.ok(JSON.stringify(around).length < 48000);
  assert.ok(around.messages.find((m) => m.id === "large15"));
  let text = "",
    cursor = 0,
    sha;
  do {
    const page = readMessageText(db, {
      chat_jid: "large-chat",
      message_id: "large15",
      offset: cursor,
      expected_sha256: sha,
    });
    text += page.text;
    cursor = page.next_offset;
    sha = page.sha256;
  } while (cursor !== null);
  assert.equal(text, body);
  assert.throws(
    () =>
      readMessageText(db, {
        chat_jid: "large-chat",
        message_id: "large15",
        offset: 4000,
      }),
    /expected_sha256/,
  );
  db.prepare("UPDATE messages SET content='edited' WHERE id='large15'").run();
  assert.throws(
    () =>
      readMessageText(db, {
        chat_jid: "large-chat",
        message_id: "large15",
        expected_sha256: sha,
      }),
    /changed/,
  );
});
