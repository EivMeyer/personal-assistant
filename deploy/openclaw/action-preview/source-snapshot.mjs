import { normalizeSlackMessages } from "./slack-source.mjs";
import { slackToken } from "./slack-auth.mjs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { digest } from "./action-store.mjs";
import {
  googleTargetRefs,
  googleSourceSnapshot,
} from "./google-action-sources.mjs";
const home = homedir();
export async function requestJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!r.ok) throw Error("Source freshness check failed: HTTP " + r.status);
  const value = await r.json();
  if (value.ok === false)
    throw Error("Source freshness check failed: " + value.error);
  return value;
}
async function gmailClient(config, source) {
  const env = config.mcp.servers[source].env;
  const keys = JSON.parse(await readFile(env.GMAIL_OAUTH_PATH, "utf8"));
  const auth = keys.installed ?? keys.web;
  const credentials = JSON.parse(
    await readFile(env.GMAIL_CREDENTIALS_PATH, "utf8"),
  );
  const token = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: auth.client_id,
      client_secret: auth.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!token.access_token) throw Error("Missing Gmail authentication");
  return (path) =>
    requestJson("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
      headers: { Authorization: "Bearer " + token.access_token },
    });
}
async function gmailSnapshot(config, ref) {
  const get = await gmailClient(config, ref.source);
  if (ref.thread) {
    const thread = await get(
      "threads/" + encodeURIComponent(ref.thread) + "?format=full",
    );
    if (!thread.messages?.length) throw Error("Source thread is missing");
    return thread.messages.map((m) => ({
      id: m.id,
      payload: stableGmailPayload(m.payload),
      internalDate: m.internalDate,
    }));
  }
  if (ref.message) {
    const m = await get(
      "messages/" + encodeURIComponent(ref.message) + "?format=full",
    );
    const thread = await get(
      "threads/" + encodeURIComponent(m.threadId) + "?format=full",
    );
    return thread.messages.map((m) => ({
      id: m.id,
      payload: stableGmailPayload(m.payload),
      internalDate: m.internalDate,
    }));
  }
  if (!ref.recipients?.length) return (await get("profile")).historyId;
  const query =
    "{" +
    ref.recipients
      .flatMap((email) => ["from:" + email, "to:" + email])
      .join(" ") +
    "}";
  const ids = [];
  let page;
  do {
    const q = new URLSearchParams({
      q: query,
      maxResults: "500",
      ...(page ? { pageToken: page } : {}),
    });
    const result = await get("messages?" + q);
    ids.push(...(result.messages ?? []).map((m) => m.id));
    page = result.nextPageToken;
    if (ids.length > 10000)
      throw Error("Conversation set too large; specify source threads");
  } while (page);
  return ids.sort();
}
export function stableGmailPayload(value) {
  if (Array.isArray(value)) return value.map(stableGmailPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "attachmentId" ? Boolean(item) : stableGmailPayload(item),
    ]),
  );
}
function whatsappSnapshot(ref) {
  const path = join(
    home,
    "repos/whatsapp-mcp/whatsapp-bridge/store/messages.db",
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id,sender,content,timestamp,is_from_me,media_type,filename,file_sha256 FROM messages WHERE chat_jid=? ORDER BY timestamp,id",
      )
      .all(ref.thread);
  } finally {
    db.close();
  }
}
async function slackSnapshot(ref, config) {
  const [channel, ts] = ref.thread.split(":");
  let cursor;
  const messages = [];
  do {
    const q = new URLSearchParams({
      channel,
      limit: "200",
      ...(ts ? { ts } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const result = await requestJson(
      "https://slack.com/api/conversations." +
        (ts ? "replies" : "history") +
        "?" +
        q,
      { headers: { Authorization: "Bearer " + slackToken(config) } },
    );
    messages.push(...result.messages);
    cursor = result.response_metadata?.next_cursor;
    if (messages.length > 10000)
      throw Error("Conversation too large; specify a Slack thread");
  } while (cursor);
  return normalizeSlackMessages(messages);
}
function extraRefs(args) {
  if (!Array.isArray(args.secretary_sources))
    throw Error(
      "Provide secretary_sources with all source conversations used for this action; use [] only for a new outbound request.",
    );
  if (args.secretary_sources.length > 20)
    throw Error("Too many source conversations");
  return args.secretary_sources.map((ref) => {
    if (
      ![
        "gmail-work",
        "gmail-personal",
        "whatsapp",
        "slack",
        "google-event",
        "google-document",
      ].includes(ref.source) ||
      typeof ref.thread !== "string" ||
      !ref.thread.trim()
    )
      throw Error("Invalid source conversation reference");
    return { source: ref.source, thread: ref.thread };
  });
}
function gmailRefs(args) {
  if (args.threadId) return [{ source: "gmail-work", thread: args.threadId }];
  const ids = args.messageIds ?? (args.messageId ? [args.messageId] : []);
  if (ids.length)
    return ids.map((message) => ({ source: "gmail-work", message }));
  const recipients = [args.to, args.cc, args.bcc].flat().filter(Boolean);
  if (
    recipients.some(
      (email) =>
        typeof email !== "string" || !/^[^\s<>:{}]+@[^\s<>:{}]+$/.test(email),
    )
  )
    throw Error("Use bare email addresses in action recipients");
  return [
    { source: "gmail-work", recipients: [...new Set(recipients)].sort() },
  ];
}
function slackRef(args) {
  const channel = args.channel_id ?? args.channel;
  if (!channel) throw Error("Missing Slack destination");
  return {
    source: "slack",
    thread: channel + (args.thread_ts ? ":" + args.thread_ts : ""),
  };
}
export function sourceRefs(server, args) {
  if (server === "setup-approval-fixture") return [{ source: "fixture" }];
  const refs = extraRefs(args);
  if (server === "google-work-actions") refs.push(...googleTargetRefs(args));
  if (server === "gmail-work-actions") refs.push(...gmailRefs(args));
  if (server === "whatsapp-actions") {
    const recipient = String(args.recipient ?? "");
    if (!recipient) throw Error("Missing WhatsApp recipient");
    refs.push({
      source: "whatsapp",
      thread: recipient.includes("@")
        ? recipient
        : recipient.replace(/^\+/, "") + "@s.whatsapp.net",
    });
  }
  if (server === "slack-actions") refs.push(slackRef(args));
  return [...new Map(refs.map((ref) => [digest(ref), ref])).values()];
}
export async function snapshotSources(server, args, config) {
  const refs = sourceRefs(server, args);
  const snapshots = [];
  for (const ref of refs) {
    let value;
    if (ref.source === "fixture")
      value = JSON.parse(
        await readFile(
          join(home, ".local/share/secretary-e2e/source.json"),
          "utf8",
        ),
      );
    else if (ref.source.startsWith("google-"))
      value = await googleSourceSnapshot(config, ref);
    else if (ref.source.startsWith("gmail-"))
      value = await gmailSnapshot(config, ref);
    else if (ref.source === "whatsapp") value = whatsappSnapshot(ref);
    else value = await slackSnapshot(ref, config);
    snapshots.push({ ref, hash: digest(value) });
  }
  return snapshots;
}
