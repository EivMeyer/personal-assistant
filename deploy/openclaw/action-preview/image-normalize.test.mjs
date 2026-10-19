import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { normalizedImage } from "./image-normalize.mjs";
import { UnreadableMedia } from "./media-unreadable.mjs";

const JPEG = Buffer.from([255, 216, 255, 224, 0, 16]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function cacheDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "secretary-image-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function fakeSips(width, height, output = JPEG) {
  const calls = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      if (args[0] === "-g")
        return `x\n  pixelWidth: ${width}\n  pixelHeight: ${height}\n`;
      await writeFile(args[args.indexOf("--out") + 1], output);
      return "";
    },
  };
}

test("large images are shrunk to a bounded JPEG once and then served from cache", async (t) => {
  const cache = await cacheDir(t);
  const bytes = Buffer.from("large source image");
  const sips = fakeSips(1206, 2622);
  const first = await normalizedImage(bytes, hash(bytes), {
    cache,
    sips: sips.run,
  });
  const second = await normalizedImage(bytes, hash(bytes), {
    cache,
    sips: sips.run,
  });
  assert.deepEqual(first, JPEG);
  assert.deepEqual(second, JPEG);
  assert.equal(sips.calls.length, 2);
  const convert = sips.calls[1];
  assert.deepEqual(
    convert.slice(convert.indexOf("-Z"), convert.indexOf("-Z") + 2),
    ["-Z", "1600"],
  );
  assert.ok(convert.includes("jpeg"));
});

test("small images are re-encoded without being enlarged", async (t) => {
  const cache = await cacheDir(t);
  const bytes = Buffer.from("small source image");
  const sips = fakeSips(800, 600);
  await normalizedImage(bytes, hash(bytes), { cache, sips: sips.run });
  assert.equal(sips.calls[1].includes("-Z"), false);
});

test("undecodable, oversized and non-JPEG results are permanent, local trouble is not", async (t) => {
  const cache = await cacheDir(t);
  const bytes = Buffer.from("not an image");
  for (const sips of [
    fakeSips("<nil>", "<nil>"),
    fakeSips(20000, 20000),
    fakeSips(100, 100, Buffer.from("PNG instead")),
  ])
    await assert.rejects(
      normalizedImage(bytes, hash(bytes), { cache, sips: sips.run }),
      UnreadableMedia,
    );
  const local = Error("Local image conversion failed; leave this image unread");
  await assert.rejects(
    normalizedImage(bytes, hash(bytes), {
      cache,
      sips: async () => {
        throw local;
      },
    }),
    (error) => error === local && !(error instanceof UnreadableMedia),
  );
  await assert.rejects(normalizedImage(bytes, "abc", { cache }), /source hash/);
});

function png16(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16; // bit depth, as in iPhone screenshots
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 6, 0x80);
  row[0] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "real 16-bit screenshots convert to a stable JPEG within 1600 pixels",
  { skip: !existsSync("/usr/bin/sips") && "needs macOS sips" },
  async (t) => {
    const cache = await cacheDir(t);
    const bytes = png16(1700, 40);
    const first = await normalizedImage(bytes, hash(bytes), { cache });
    assert.deepEqual(first.subarray(0, 3), Buffer.from([255, 216, 255]));
    const path = join(cache, "check.jpg");
    await writeFile(path, first);
    const size = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", path], {
      encoding: "utf8",
    });
    assert.match(size, /pixelWidth: 1600/);
    assert.deepEqual(
      await normalizedImage(bytes, hash(bytes), { cache }),
      first,
    );
    const garbage = Buffer.from("garbage bytes");
    await assert.rejects(
      normalizedImage(garbage, hash(garbage), { cache }),
      UnreadableMedia,
    );
  },
);
