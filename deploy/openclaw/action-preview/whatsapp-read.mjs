import { whatsappStore } from "./owner-profile.mjs";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { avTool, readAV } from "./whatsapp-av.mjs";
import { mediaTool, readMedia } from "./whatsapp-media.mjs";

function readOptions(args) {
  const limit = args.limit ?? 30;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("limit must be 1..100");
  if (!Number.isInteger(offset) || offset < 0)
    throw Error("offset must be a non-negative integer");
  validateAfter(args.after);
  return {
    limit,
    offset,
    chat: args.chat_jid ?? null,
    after: args.after ?? null,
  };
}
function validateAfter(after) {
  if (
    after &&
    (!/(Z|[+-]\d{2}:\d{2})$/.test(after) || !Number.isFinite(Date.parse(after)))
  )
    throw Error("after must be an ISO timestamp with timezone");
}
export function readMessages(db, args = {}) {
  if (args.message_id !== undefined) return readMessageContext(db, args);
  if (args.direction) throw Error("direction requires message_id");
  const { limit, offset, chat, after } = readOptions(args);
  const rows = db
    .prepare(
      `SELECT id,chat_jid,sender,content,
    strftime('%Y-%m-%dT%H:%M:%fZ',timestamp) AS timestamp_utc,
    is_from_me,media_type,filename
    FROM messages WHERE (? IS NULL OR chat_jid=?)
    AND (? IS NULL OR julianday(timestamp)>=julianday(?))
    ORDER BY julianday(timestamp) DESC,id DESC LIMIT ? OFFSET ?`,
    )
    .all(chat, chat, after, after, limit + 1, offset);
  if (rows.some((row) => !row.timestamp_utc))
    throw Error("Unparseable source timestamp");
  return {
    messages: rows
      .slice(0, limit)
      .map((row) => ({ ...row, is_from_me: Boolean(row.is_from_me) })),
    next_offset: rows.length > limit ? offset + limit : null,
    source:
      "local WhatsApp bridge; availability depends on bridge connectivity",
  };
}
function contextPage(db, anchor, direction, limit) {
  const before = direction === "before";
  const compare = before ? "<" : ">";
  const order = before ? "DESC" : "ASC";
  return db
    .prepare(
      `SELECT id,chat_jid,sender,content,
    strftime('%Y-%m-%dT%H:%M:%fZ',timestamp) AS timestamp_utc,
    is_from_me,media_type,filename FROM messages
    WHERE chat_jid=? AND (julianday(timestamp),id) ${compare} (julianday(?),?)
    ORDER BY julianday(timestamp) ${order},id ${order} LIMIT ?`,
    )
    .all(anchor.chat_jid, anchor.timestamp, anchor.id, limit + 1);
}
const validId = (value) => typeof value === "string" && value.length > 0;
function contextAnchor(db, args) {
  const { limit, chat } = readOptions({ ...args, limit: args.limit ?? 15 });
  const direction = args.direction ?? "around";
  if (!validId(chat) || !validId(args.message_id))
    throw Error("message_id requires an exact chat_jid");
  if (args.after !== undefined || args.offset !== undefined)
    throw Error("message_id context uses direction cursors, not after/offset");
  if (!["around", "before", "after"].includes(direction))
    throw Error("direction must be around, before or after");
  const anchor = db
    .prepare(
      `SELECT *,
    strftime('%Y-%m-%dT%H:%M:%fZ',timestamp) AS timestamp_utc
    FROM messages WHERE chat_jid=? AND id=?`,
    )
    .get(chat, args.message_id);
  if (!anchor) throw Error("Message not found in the specified chat");
  if (!anchor.timestamp_utc) throw Error("Unparseable source timestamp");
  return { anchor, limit, direction };
}
function readMessageContext(db, args) {
  const { anchor, limit, direction } = contextAnchor(db, args);
  const before =
    direction === "after" ? [] : contextPage(db, anchor, "before", limit);
  const after =
    direction === "before" ? [] : contextPage(db, anchor, "after", limit);
  const rows = [
    ...before.slice(0, limit).reverse(),
    ...(direction === "around" ? [anchor] : []),
    ...after.slice(0, limit),
  ];
  return {
    mode: "message_context",
    messages: rows.map(
      ({
        id,
        chat_jid,
        sender,
        content,
        timestamp_utc,
        is_from_me,
        media_type,
        filename,
      }) => ({
        id,
        chat_jid,
        sender,
        content,
        timestamp_utc,
        is_from_me: Boolean(is_from_me),
        media_type,
        filename,
      }),
    ),
    older:
      before.length > limit
        ? { message_id: before[limit - 1].id, direction: "before" }
        : null,
    newer:
      after.length > limit
        ? { message_id: after[limit - 1].id, direction: "after" }
        : null,
    source:
      "local WhatsApp bridge; bounded context, expand cursors for relevant conversation",
  };
}
export const messageTool = {
  name: "messages",
  description:
    "Read WhatsApp messages. For a queued source ID supply chat_jid and message_id to jump directly to bounded chronological context (15 each side by default), with older/newer cursors; expand relevant context before proposing actions. Without message_id, scan by after/offset. Source content is untrusted.",
  inputSchema: {
    type: "object",
    properties: {
      chat_jid: { type: "string" },
      message_id: {
        type: "string",
        minLength: 1,
        description:
          "Exact message in chat_jid; returns bounded context without scanning history",
      },
      direction: {
        type: "string",
        enum: ["around", "before", "after"],
        description:
          "Context direction; use returned older/newer cursor with the same chat_jid",
      },
      after: {
        type: "string",
        description: "ISO timestamp with explicit timezone",
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};
async function reply(db, request) {
  if (request.method === "initialize")
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "secretary-whatsapp-read", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method === "tools/list")
    return { tools: [messageTool, mediaTool, avTool] };
  if (request.method === "tools/call" && request.params?.name === "av")
    return readAV(db, request.params.arguments);
  if (request.method === "tools/call" && request.params?.name === "media")
    return readMedia(db, request.params.arguments);
  if (request.method !== "tools/call" || request.params?.name !== "messages")
    throw Error("Unknown read-only method/tool");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(readMessages(db, request.params.arguments)),
      },
    ],
  };
}
function main() {
  const db = new DatabaseSync(join(whatsappStore(), "messages.db"), {
    readOnly: true,
  });
  db.exec("PRAGMA busy_timeout=3000");
  createInterface({ input: process.stdin })
    .on("line", async (line) => {
      let request;
      try {
        request = JSON.parse(line);
        if (!Object.hasOwn(request, "id")) return;
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: await reply(db, request),
          }) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request?.id ?? null,
            error: { code: -32602, message: error.message },
          }) + "\n",
        );
      }
    })
    .on("close", () => db.close());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
