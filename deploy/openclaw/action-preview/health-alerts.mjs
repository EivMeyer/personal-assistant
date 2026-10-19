import { ownerProfile } from "./owner-profile.mjs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export function healthAlert(event, ctx, lastSent, now) {
  if (
    ctx.channelId !== "telegram" ||
    String(event.to).replace(/^telegram:/, "") !== ownerProfile().telegramUserId
  )
    return;
  if (
    event.content !==
    "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available."
  )
    return;
  if (lastSent && now - lastSent < 3_600_000)
    return {
      cancel: true,
      cancelReason:
        "Repeated background failure; retained in gateway diagnostics.",
    };
  return {
    content:
      "Background checks failed. Some incoming messages may still be waiting for review.",
  };
}
// OpenClaw posts "⚠️ <tool> failed" whenever a tool errored during a heartbeat that
// otherwise stayed quiet, even when the check handled the error and will retry the
// item. Those bare notices give the owner nothing to act on. Only one-line tool
// notices from background runs are dropped; run, login and system failures still
// arrive, and an unrecognised format is delivered unchanged.
const TOOL_WARNING =
  /^⚠️ (?!(?:Agent|Model|LLM|Memory|Heartbeat|Command|Restart|Update|OpenClaw|Plugin|Gateway|Context|Config|ACP|CLI)\b)[^\n]{1,160}? (?:failed|blocked|timed out after [\d.]+s)(?:$|[\s:.;(])/u;
export function backgroundToolWarning(event, ctx) {
  if (
    ctx.channelId !== "telegram" ||
    String(event.to).replace(/^telegram:/, "") !==
      ownerProfile().telegramUserId ||
    !/:heartbeat$/.test(ctx.sessionKey ?? "") ||
    typeof event.content !== "string" ||
    event.content.includes("\n") ||
    !TOOL_WARNING.test(event.content)
  )
    return;
  return {
    cancel: true,
    cancelReason:
      "Handled background tool error; unread items stay queued for retry.",
  };
}
export function registerHealthAlerts(api) {
  const db = new DatabaseSync(
    join(homedir(), ".local/share/secretary-context/visible.sqlite"),
  );
  db.exec(
    "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS health_alerts (name TEXT PRIMARY KEY, sentAt INTEGER NOT NULL)",
  );
  api.on("message_sending", (event, ctx) => {
    const last = db
      .prepare("SELECT sentAt FROM health_alerts WHERE name='background'")
      .get()?.sentAt;
    return (
      healthAlert(event, ctx, last, Date.now()) ??
      backgroundToolWarning(event, ctx)
    );
  });
  api.on("message_sent", (event, ctx) => {
    if (
      event.success &&
      ctx.channelId === "telegram" &&
      String(event.to).replace(/^telegram:/, "") ===
        ownerProfile().telegramUserId &&
      event.content ===
        "Background checks failed. Some incoming messages may still be waiting for review."
    )
      db.prepare(
        "INSERT INTO health_alerts VALUES('background',?) ON CONFLICT(name) DO UPDATE SET sentAt=excluded.sentAt",
      ).run(Date.now());
  });
  api.on("gateway_stop", () => db.close());
}
