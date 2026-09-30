import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readMessages } from "./whatsapp-read.mjs";
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
