import { ownerProfile } from "./owner-profile.mjs";
import { actionReceiptText } from "./approval-copy.mjs";
import { readFile } from "node:fs/promises";
import { requestJson } from "./source-snapshot.mjs";
import { VisibleConversation } from "./conversation-context.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
export const receiptText = actionReceiptText;
export function registerReceiptDelivery(api, store) {
  let busy = false;
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      store.recover();
      for (const pending of store.receipts()) {
        const row = store.claimReceipt(pending.id);
        if (!row) continue;
        const content = receiptText(row);
        const messageId = await sendOwnerText(api.config, content);
        store.notified(row.id);
        captureOwnerText(content, messageId);
      }
    } catch (error) {
      api.logger.warn("Secretary receipt delivery pending: " + error.message);
    } finally {
      busy = false;
    }
  }
  let timer;
  api.registerService({
    id: "secretary-receipts",
    start() {
      timer = setInterval(() => void flush(), 2000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  });
  return flush;
}

export function registerAbandonedRunStatus(api, store) {
  const replaced = new Map();
  api.on("agent_end", (event, ctx) => {
    const cancelled = store.cancelPendingRun(event.runId ?? ctx.runId);
    if (cancelled.length && ctx.sessionKey)
      replaced.set(ctx.sessionKey, Date.now());
  });
  api.on("message_received", (_event, ctx) => replaced.delete(ctx.sessionKey));
  api.on("message_sending", (event, ctx) => {
    const at = replaced.get(ctx.sessionKey);
    if (
      ctx.channelId !== "telegram" ||
      String(event.to).replace(/^telegram:/, "") !==
        ownerProfile().telegramUserId
    )
      return;
    if (at && Date.now() - at < 30000)
      return {
        cancel: true,
        cancelReason:
          "The durable action receipt supplies the verified terminal outcome.",
      };
  });
}

export async function sendOwnerText(config, content) {
  const token = (
    await readFile(config.channels.telegram.tokenFile, "utf8")
  ).trim();
  const result = await requestJson(
    "https://api.telegram.org/bot" + token + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ownerProfile().telegramUserId,
        text: content,
        link_preview_options: { is_disabled: true },
      }),
    },
  );
  if (!result.ok || !result.result?.message_id)
    throw Error("Telegram receipt missing");
  return result.result.message_id;
}
export function captureOwnerText(content, messageId) {
  const conversation = new VisibleConversation(
    join(homedir(), ".local/share/secretary-context/visible.sqlite"),
  );
  try {
    conversation.capture(
      "assistant",
      { to: ownerProfile().telegramUserId, success: true, messageId, content },
      { channelId: "telegram", conversationId: ownerProfile().telegramUserId },
    );
  } finally {
    conversation.close();
  }
}
