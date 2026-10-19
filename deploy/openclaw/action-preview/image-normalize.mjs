import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UnreadableMedia } from "./media-unreadable.mjs";

const execute = promisify(execFile);
const MAX_EDGE = 1600;
const MAX_PIXELS = 100_000_000;
const pending = new Map();

// Phone screenshots arrive as multi-megabyte, often 16-bit PNG or HEIC files. Sent
// raw they take 100+ chunk calls, and the image viewer still rejects them. A bounded
// 8-bit JPEG takes a few chunks and opens everywhere. The cache keeps the bytes, and
// so the chunk hashes, identical across calls and runs.
export async function normalizedImage(bytes, sha256, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw Error("Image conversion needs the verified source hash");
  const cache =
    options.cache ?? join(homedir(), ".local/share/secretary-media");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const target = join(cache, sha256 + "-image-v1.jpg");
  try {
    return await readFile(target);
  } catch {}
  if (!pending.has(target))
    pending.set(
      target,
      convert(bytes, cache, target, options.sips ?? sips).finally(() =>
        pending.delete(target),
      ),
    );
  await pending.get(target);
  return readFile(target);
}

async function convert(bytes, cache, target, run) {
  const dir = await mkdtemp(join(cache, "image-"));
  try {
    const input = join(dir, "source.bin");
    const output = join(dir, "image.jpg");
    await writeFile(input, bytes, { mode: 0o600 });
    const size = await run(["-g", "pixelWidth", "-g", "pixelHeight", input]);
    const width = Number(/pixelWidth: (\d+)/.exec(size)?.[1]);
    const height = Number(/pixelHeight: (\d+)/.exec(size)?.[1]);
    if (!(width > 0 && height > 0))
      throw new UnreadableMedia("Image could not be decoded");
    if (width * height > MAX_PIXELS)
      throw new UnreadableMedia("Image exceeds the 100-megapixel read limit");
    // sips -Z also enlarges, so only pass it for images over the limit.
    const resize =
      Math.max(width, height) > MAX_EDGE ? ["-Z", String(MAX_EDGE)] : [];
    await run([
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "80",
      ...resize,
      input,
      "--out",
      output,
    ]);
    const jpeg = await readFile(output);
    if (!jpeg.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
      throw new UnreadableMedia("Image could not be decoded");
    await rename(output, target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function sips(args) {
  try {
    const { stdout } = await execute("/usr/bin/sips", args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // An exit status means sips read the file and refused it. A missing binary
    // or a timeout is local trouble, so the read stays pending for a retry.
    if (typeof error?.code === "number")
      throw new UnreadableMedia("Image could not be decoded");
    throw Error("Local image conversion failed; leave this image unread");
  }
}
