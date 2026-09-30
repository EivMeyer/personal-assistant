import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readMedia } from "./whatsapp-media.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "secretary-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE messages(id TEXT,chat_jid TEXT,media_type TEXT,file_sha256 BLOB)",
  );
  const bytes = Buffer.from([255, 216, 255, 0, 1, 2]);
  db.prepare("INSERT INTO messages VALUES('image','chat','image',?)").run(
    createHash("sha256").update(bytes).digest(),
  );
  const path = join(root, "image.jpg");
  await writeFile(path, bytes);
  const request = async () => ({
    ok: true,
    json: async () => ({ success: true, path }),
  });
  return { db, root, path, bytes, request };
}
test("scoped image reader returns verified image bytes without general file access", async (t) => {
  const f = await fixture(t);
  const r = await readMedia(f.db, { message_id: "image", chat_jid: "chat" }, f);
  const image = JSON.parse(r.content[0].text);
  assert.equal(image.mime_type, "image/jpeg");
  assert.deepEqual(Buffer.from(image.image_data.join(""), "base64"), f.bytes);
  await assert.rejects(
    readMedia(f.db, { message_id: "image", chat_jid: "other" }, f),
    /not found/,
  );
  await assert.rejects(
    readMedia(f.db, { message_id: "image", chat_jid: "chat", path: f.path }, f),
    /only an exact/,
  );
});
test("wrong cached image, escaped paths and unsupported media remain unread", async (t) => {
  const f = await fixture(t);
  const args = { message_id: "image", chat_jid: "chat" };
  await writeFile(f.path, "another image");
  await assert.rejects(readMedia(f.db, args, f), /hash does not match/);
  await assert.rejects(
    readMedia(f.db, args, { ...f, root: join(f.root, "image.jpg") }),
    /outside the media store/,
  );
  f.db.exec("UPDATE messages SET media_type='video'");
  await assert.rejects(readMedia(f.db, args, f), /continue other messages/);
});

test("large image chunks stay below the native tool text limit and reconstruct exactly", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.concat([f.bytes, Buffer.alloc(75000, 7)]);
  await writeFile(f.path, bytes);
  const hash = createHash("sha256").update(bytes).digest();
  f.db.prepare("UPDATE messages SET file_sha256=?").run(hash);
  let offset = 0;
  const chunks = [];
  do {
    const r = await readMedia(
      f.db,
      { message_id: "image", chat_jid: "chat", offset },
      f,
    );
    assert.ok(r.content[0].text.length < 50000);
    const part = JSON.parse(r.content[0].text);
    assert.equal(part.sha256, hash.toString("hex"));
    assert.equal(part.offset, offset);
    assert.ok(part.image_data.every((segment) => segment.length <= 16));
    chunks.push(part.image_data.join(""));
    offset = part.next_offset;
  } while (offset !== null);
  assert.deepEqual(Buffer.from(chunks.join(""), "base64"), bytes);
  await assert.rejects(
    readMedia(f.db, { message_id: "image", chat_jid: "chat", offset: -1 }, f),
    /offset/,
  );
});
