import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifiedSlackFile } from "./slack-media-source.mjs";
import { readSlackMedia } from "./slack-media.mjs";
import { UnreadableMedia } from "./media-unreadable.mjs";
const bytes = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(30000),
]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const source = { bytes, kind: "image", sha256, fileId: "F123", capturedAt: 1 };
function options(
  fileUrl = "https://files.slack.com/files-pri/file",
  size = bytes.length,
) {
  const calls = [];
  return {
    calls,
    token: "fixture-only",
    verify: async () => calls.push("verified"),
    cache: new Map(),
    request: async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes("files.info"))
        return Response.json({
          ok: true,
          file: {
            id: "F123",
            url_private_download: fileUrl,
            mimetype: "image/png",
            size,
          },
        });
      return new Response(bytes);
    },
  };
}
test("Slack media verifies identity before reads and hashes complete bytes", async () => {
  const opts = options();
  const result = await verifiedSlackFile("F123", opts);
  assert.equal(opts.calls[0], "verified");
  assert.equal(result.sha256, sha256);
  assert.equal(result.bytes.length, bytes.length);
});
test("Slack files reject credential exfiltration URLs, redirects, truncation and unverified accounts", async () => {
  for (const url of [
    "http://files.slack.com/f",
    "https://evil.example/f",
    "https://files.slack.com.evil.example/f",
    "https://user@files.slack.com/f",
  ])
    await assert.rejects(verifiedSlackFile("F123", options(url)), /outside/);
  await assert.rejects(
    verifiedSlackFile("F123", options(undefined, bytes.length + 1)),
    /size/,
  );
  const opts = options();
  opts.verify = async () => {
    throw Error("identity mismatch");
  };
  await assert.rejects(verifiedSlackFile("F123", opts), /identity/);
  assert.equal(opts.calls.length, 0);
  const redirects = options();
  const original = redirects.request;
  redirects.request = async (url, opts) =>
    url.includes("files.info")
      ? original(url, opts)
      : new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        });
  await assert.rejects(verifiedSlackFile("F123", redirects), /outside/);
});
test("Slack images preserve hashes through all chunks and fail on source changes", async () => {
  // Chunking is tested on the converted bytes; conversion has its own tests.
  const opts = { source: async () => source, normalize: async (b) => b };
  const first = await readSlackMedia({ file_id: "F123" }, opts);
  const second = await readSlackMedia(
    { file_id: "F123", offset: first.next_offset, expected_sha256: sha256 },
    opts,
  );
  assert.equal(first.sha256, second.sha256);
  assert.equal(second.next_offset, null);
  assert.deepEqual(
    Buffer.from([...first.image_data, ...second.image_data].join(""), "base64"),
    bytes,
  );
  await assert.rejects(
    readSlackMedia({ file_id: "F123", expected_sha256: "0".repeat(64) }, opts),
    /changed/,
  );
});
test("Slack video forwards window coverage and does not inherit WhatsApp provenance", async () => {
  const result = await readSlackMedia(
    { file_id: "F123", start_seconds: 30 },
    {
      source: async () => ({ ...source, kind: "video" }),
      analyze: async (_source, start) => ({
        image: Buffer.from("sheet"),
        metadata: {
          source: "WhatsApp",
          start_seconds: start,
          next_start_seconds: 60,
          transcript: { review_required: true },
        },
      }),
    },
  );
  assert.equal(result.next_start_seconds, 60);
  assert.equal(result.start_seconds, 30);
  assert.equal(result.source, "untrusted Slack attachment");
  assert.equal(result.transcript.review_required, true);
});
test("Slack images are read as the converted JPEG with the source hash kept", async () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
  const seen = [];
  const result = await readSlackMedia(
    { file_id: "F123" },
    {
      source: async () => source,
      normalize: async (bytes, hash) => {
        seen.push(hash);
        return jpeg;
      },
    },
  );
  assert.deepEqual(seen, [sha256]);
  assert.equal(result.mime_type, "image/jpeg");
  assert.equal(result.source_sha256, sha256);
  assert.deepEqual(Buffer.from(result.image_data.join(""), "base64"), jpeg);
});
test("Slack files that can never be opened return a complete result instead of an error", async () => {
  for (const [mimetype, size, reason] of [
    ["application/zip", 4000, /Unsupported/],
    ["video/mp4", 200 * 1024 * 1024, /100 MiB/],
  ]) {
    const opts = options();
    const original = opts.request;
    opts.request = async (url, o) =>
      url.includes("files.info")
        ? Response.json({
            ok: true,
            file: {
              id: "F123",
              name: "bundle.zip",
              url_private_download: "https://files.slack.com/files-pri/file",
              mimetype,
              size,
            },
          })
        : original(url, o);
    const file = await verifiedSlackFile("F123", opts);
    assert.match(file.unreadable, reason);
    // Nothing is downloaded for a file that cannot be read.
    assert.equal(
      opts.calls.filter((c) => c.url?.includes("files-pri")).length,
      0,
    );
    const result = await readSlackMedia(
      { file_id: "F123" },
      { source: async () => file },
    );
    assert.equal(result.readable, false);
    assert.equal(result.next_offset, null);
    assert.equal(result.filename, "bundle.zip");
    assert.match(result.reason, reason);
  }
  const undecodable = await readSlackMedia(
    { file_id: "F123" },
    {
      source: async () => source,
      normalize: async () => {
        throw new UnreadableMedia("Image could not be decoded");
      },
    },
  );
  assert.equal(undecodable.readable, false);
  assert.equal(undecodable.source_sha256, sha256);
  await assert.rejects(
    readSlackMedia(
      { file_id: "F123" },
      {
        source: async () => source,
        normalize: async () => {
          throw Error("Local image conversion failed; leave this image unread");
        },
      },
    ),
    /leave this image unread/,
  );
});
