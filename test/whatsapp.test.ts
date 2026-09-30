import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WhatsAppSource } from "../src/adapters/whatsapp.ts";
import { harness } from "./helpers.ts";

function bridgeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "assistant-wa-"));
  const messagesDb = join(dir, "messages.db");
  const sessionDb = join(dir, "session.db");
  const messages = new Database(messagesDb);
  messages.exec(
    "CREATE TABLE messages(id TEXT,chat_jid TEXT,sender TEXT,content TEXT,timestamp TEXT,is_from_me INTEGER,media_type TEXT)",
  );
  const session = new Database(sessionDb);
  session.exec(
    "CREATE TABLE whatsmeow_device(jid TEXT); INSERT INTO whatsmeow_device VALUES ('4712345678:2@s.whatsapp.net')",
  );
  session.close();
  return {
    messages,
    options: {
      messagesDb,
      sessionDb,
      selfJid: "4712345678@s.whatsapp.net",
      bridgeUrl: "http://127.0.0.1:8080",
      allowGroups: false,
    },
    close: () => {
      messages.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("WhatsApp baseline, incoming checkpoint, media gap and group exclusion", async (t) => {
  const h = harness();
  const fixture = bridgeFixture();
  const source = new WhatsAppSource(fixture.options, h.store);
  t.after(() => {
    source.close();
    fixture.close();
    h.close();
  });
  await source.poll();
  fixture.messages
    .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)")
    .run(
      "m1",
      "4798765432@s.whatsapp.net",
      "Alice",
      "Hello",
      new Date().toISOString(),
      0,
      "",
    );
  await source.poll();
  assert.equal(h.store.get("cursor:whatsapp"), "1");
  const context = await source.conversation("4798765432@s.whatsapp.net");
  assert.equal(context.complete, true);
  assert.equal(context.messages.length, 1);
  assert.equal((await source.route(context))?.to, "4798765432@s.whatsapp.net");
  assert.equal(await source.route({ ...context, thread: "123@g.us" }), null);
  fixture.messages.exec("UPDATE messages SET media_type='audio'");
  assert.equal((await source.conversation(context.thread)).complete, false);
});
test("WhatsApp refuses a different linked account", async (t) => {
  const h = harness();
  const fixture = bridgeFixture();
  const source = new WhatsAppSource(
    { ...fixture.options, selfJid: "4799999999@s.whatsapp.net" },
    h.store,
  );
  t.after(() => {
    source.close();
    fixture.close();
    h.close();
  });
  await assert.rejects(source.verify(), /identity/);
});
