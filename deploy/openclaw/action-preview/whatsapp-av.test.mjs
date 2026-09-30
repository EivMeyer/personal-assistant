import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAV } from "./whatsapp-av.mjs";
import { avWindow, transcriptQuality } from "./media-av.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "secretary-av-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.mp4");
  const bytes = Buffer.from("verified source fixture");
  await writeFile(path, bytes);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE messages(id TEXT,chat_jid TEXT,media_type TEXT,file_sha256 BLOB)",
  );
  db.prepare("INSERT INTO messages VALUES('media','chat','video',?)").run(
    createHash("sha256").update(bytes).digest(),
  );
  const request = async () => ({
    ok: true,
    json: async () => ({ success: true, path }),
  });
  return { root, path, bytes, db, request };
}
test("AV reader binds transcript and every contact-sheet chunk to the verified source", async (t) => {
  const f = await fixture(t);
  const sheet = Buffer.alloc(65000, 7);
  let calls = 0,
    offset = 0;
  const chunks = [];
  const analyze = async (source, start) => {
    calls++;
    assert.deepEqual(source.bytes, f.bytes);
    assert.equal(start, 30);
    return {
      image: sheet,
      metadata: {
        source_sha256: source.sha256,
        start_seconds: start,
        next_start_seconds: 60,
        transcript: { text: "Example transcript" },
      },
    };
  };
  do {
    const r = await readAV(
      f.db,
      { message_id: "media", chat_jid: "chat", start_seconds: 30, offset },
      { ...f, analyze },
    );
    const part = JSON.parse(r.content[0].text);
    assert.equal(part.next_start_seconds, 60);
    assert.equal(
      part.source_sha256,
      createHash("sha256").update(f.bytes).digest("hex"),
    );
    assert.equal(part.sha256, createHash("sha256").update(sheet).digest("hex"));
    assert.ok(r.content[0].text.length < 50000);
    chunks.push(...part.image_data);
    offset = part.next_offset;
  } while (offset !== null);
  assert.deepEqual(Buffer.from(chunks.join(""), "base64"), sheet);
  const before = calls;
  await writeFile(f.path, "wrong cached media");
  await assert.rejects(
    readAV(f.db, { message_id: "media", chat_jid: "chat" }, { ...f, analyze }),
    /hash does not match/,
  );
  assert.equal(calls, before);
});
test("audio returns transcript without fake images; invalid ranges and extra paths fail", async (t) => {
  const f = await fixture(t);
  f.db.exec("UPDATE messages SET media_type='audio'");
  const analyze = async () => ({
    image: null,
    metadata: { transcript: { text: "Hello" }, next_start_seconds: null },
  });
  const args = { message_id: "media", chat_jid: "chat" };
  const r = JSON.parse(
    (await readAV(f.db, args, { ...f, analyze })).content[0].text,
  );
  assert.equal(r.transcript.text, "Hello");
  assert.equal(r.image_data, undefined);
  await assert.rejects(
    readAV(f.db, { ...args, offset: 1 }, { ...f, analyze }),
    /no image chunks/,
  );
  await assert.rejects(
    readAV(f.db, { ...args, start_seconds: 1 }, f),
    /window/,
  );
  await assert.rejects(
    readAV(f.db, { ...args, path: f.path }, f),
    /only an exact/,
  );
});
test("AV windows expose remaining content and reject absent, excessive or invalid duration", () => {
  const probe = {
    format: { duration: "65.5" },
    streams: [{ codec_type: "video" }, { codec_type: "audio" }],
  };
  assert.equal(avWindow(probe, 0).next_start_seconds, 30);
  assert.equal(avWindow(probe, 30).next_start_seconds, 60);
  assert.equal(avWindow(probe, 60).next_start_seconds, null);
  assert.equal(avWindow(probe, 60).end_seconds, 65.5);
  for (const start of [-1, 1, 90, NaN])
    assert.throws(() => avWindow(probe, start));
  assert.throws(() => avWindow({ ...probe, format: { duration: "N/A" } }, 0));
  assert.throws(() => avWindow({ ...probe, format: { duration: "7201" } }, 0));
});

test("specific video moments use the frame reader and preserve source identity", async (t) => {
  const f = await fixture(t);
  let requested;
  const frameReader = async (source, at) => {
    requested = at;
    return {
      image: Buffer.from([255, 216, 255]),
      metadata: { source_sha256: source.sha256, frame_seconds: at },
    };
  };
  const args = { message_id: "media", chat_jid: "chat", frame_seconds: 1.25 };
  const result = JSON.parse(
    (await readAV(f.db, args, { ...f, frameReader })).content[0].text,
  );
  assert.equal(requested, 1.25);
  assert.equal(result.frame_seconds, 1.25);
  assert.equal(
    result.source_sha256,
    createHash("sha256").update(f.bytes).digest("hex"),
  );
  await assert.rejects(
    readAV(f.db, { ...args, start_seconds: 30 }, f),
    /either/,
  );
  f.db.exec("UPDATE messages SET media_type='audio'");
  await assert.rejects(readAV(f.db, args, f), /Wrong media type/);
});

test("uncertain speech carries source timestamps and explicit review requirements", () => {
  const segment = {
    start: 1,
    end: 2,
    text: "Example",
    avg_logprob: -0.2,
    no_speech_prob: 0.01,
  };
  const good = transcriptQuality({ text: "Example", segments: [segment] }, 30);
  assert.equal(good.review_required, false);
  assert.equal(good.accuracy_guaranteed, false);
  assert.equal(good.segments[0].source_start_seconds, 31);
  for (const patch of [
    { avg_logprob: -1 },
    { no_speech_prob: 0.8 },
    { avg_logprob: undefined },
  ]) {
    const result = transcriptQuality({
      text: "Example",
      segments: [{ ...segment, ...patch }],
    });
    assert.equal(result.review_required, true);
    assert.equal(result.segments[0].uncertain, true);
  }
  assert.equal(
    transcriptQuality({ text: "Unscored", segments: [] }).review_required,
    true,
  );
  assert.equal(
    transcriptQuality({ text: "", segments: [], no_audio_track: true })
      .review_required,
    false,
  );
});
