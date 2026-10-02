import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifiedSlackFile } from "./slack-media-source.mjs";
import { readSlackMedia } from "./slack-media.mjs";
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
  const opts = { source: async () => source };
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
