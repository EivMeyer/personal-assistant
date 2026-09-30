import { whatsappStore } from "./owner-profile.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { homedir } from "node:os";

function validateArgs(args) {
  if (
    !args ||
    Object.keys(args).some((k) => !["message_id", "chat_jid"].includes(k)) ||
    typeof args.message_id !== "string" ||
    !args.message_id ||
    typeof args.chat_jid !== "string" ||
    !args.chat_jid
  )
    throw Error("Provide only an exact message_id and chat_jid");
}
function sourceMedia(db, args) {
  validateArgs(args);
  const row = db
    .prepare(
      "SELECT media_type,file_sha256 FROM messages WHERE id=? AND chat_jid=?",
    )
    .get(args.message_id, args.chat_jid);
  if (!row) throw Error("Message not found in that chat");
  if (!["image", "audio", "video"].includes(row.media_type))
    throw Error(
      "Unsupported media type; leave unread and continue other messages",
    );
  if (!row.file_sha256 || row.file_sha256.length !== 32)
    throw Error("Missing source image hash");
  return row;
}
async function downloadPath(args, request) {
  const response = await request("http://127.0.0.1:8080/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: args.message_id,
      chat_jid: args.chat_jid,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("WhatsApp image download failed");
  const result = await response.json();
  if (!result.success || typeof result.path !== "string")
    throw Error("WhatsApp image is unavailable");
  return result.path;
}
async function verifiedBytes(downloadedPath, hash, options) {
  const root = await realpath(options.root ?? whatsappStore());
  const path = await realpath(downloadedPath);
  if (!path.startsWith(root + sep))
    throw Error("Media path is outside the media store");
  const info = await stat(path);
  if (!info.isFile() || info.size > options.maxBytes)
    throw Error("Media exceeds the read limit");
  const bytes = await readFile(path);
  if (!createHash("sha256").update(bytes).digest().equals(Buffer.from(hash)))
    throw Error("Media hash does not match this source message");
  return { bytes, path };
}
export async function verifiedMedia(db, args, options = {}) {
  const row = sourceMedia(db, args);
  if (options.kind && !options.kind.includes(row.media_type))
    throw Error("Wrong media type for this reader; continue other messages");
  const path = await downloadPath(args, options.request ?? fetch);
  const result = await verifiedBytes(path, row.file_sha256, {
    ...options,
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
  });
  return {
    ...result,
    kind: row.media_type,
    sha256: Buffer.from(row.file_sha256).toString("hex"),
  };
}

export function imageChunk(bytes, offset, metadata = {}) {
  if (!Number.isInteger(offset) || offset < 0)
    throw Error("Invalid image chunk offset");
  const data = bytes.toString("base64");
  if (offset >= data.length)
    throw Error("Image chunk offset exceeds image length");
  const end = Math.min(offset + 32000, data.length);
  return {
    ...metadata,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    image_data: data.slice(offset, end).match(/.{1,16}/g),
    offset,
    next_offset: end < data.length ? end : null,
  };
}
