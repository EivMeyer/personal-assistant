import { readFile } from "node:fs/promises";
import { actionFieldLines } from "./approval-copy.mjs";
import { ownerProfile } from "./owner-profile.mjs";
import { captureOwnerText } from "./receipt-delivery.mjs";

// Mirrors the review queue into the owner's Telegram chat. Each open item gets
// one message that is edited in place as its state changes. Buttons only open
// an item or set it aside; the native approval prompt stays the only way to send.
export const NAMESPACE = "rq";
const LIMIT = 3800;
const CLOSED = {
  completed: "Done",
  rejected: "Set aside. Nothing was sent",
  blocked: "Blocked. Nothing was sent",
  expired: "Expired. Nothing was sent",
  failed: "Failed",
  unknown: "Outcome unknown. Not retried",
};

function clip(text) {
  return text.length > LIMIT
    ? text.slice(0, LIMIT) + "\n[Shortened here. The approval shows all of it.]"
    : text;
}
function fields(item) {
  return item.action ? actionFieldLines(item.action.args).join("\n\n") : "";
}
function button(text, op, item) {
  return {
    text,
    callback_data: `${NAMESPACE}:${op}:${item.id}:${item.version}`,
  };
}
export function itemMessage(item) {
  const error = item.error ? "\n\n" + item.error : "";
  if (CLOSED[item.state])
    return {
      text: `${CLOSED[item.state]}: ${item.title}${error}`,
      buttons: [],
    };
  if (item.state === "needs_info")
    return {
      text: clip(
        `Question: ${item.title}\n\n${item.question || "What should I do here?"}${error}\n\nReply to this message to answer.`,
      ),
      buttons: [[button("Set aside", "x", item)]],
    };
  if (item.state === "answered")
    return {
      text: clip(
        `Answered: ${item.title}\n\nYou: ${item.answer}\n\nPreparing the next step.`,
      ),
      buttons: [],
    };
  if (item.state === "opening")
    return {
      text: clip(
        `Opening: ${item.title}\n\n${fields(item)}\n\nThe exact approval follows. Nothing is sent until you choose Go ahead there.`,
      ),
      buttons: [],
    };
  return {
    text: clip(`Ready: ${item.title}\n\n${fields(item)}${error}`),
    buttons: [[button("Send…", "o", item), button("Set aside", "x", item)]],
  };
}

export function telegramBot(config, request = fetch) {
  async function call(method, body) {
    const token = (
      await readFile(config.channels.telegram.tokenFile, "utf8")
    ).trim();
    const response = await request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const value = await response.json();
    if (!value.ok) throw Error(value.description ?? "Telegram call failed");
    return value.result;
  }
  const chat_id = () => ownerProfile().telegramUserId;
  const markup = (buttons) => ({ inline_keyboard: buttons });
  return {
    async send({ text, buttons }) {
      const result = await call("sendMessage", {
        chat_id: chat_id(),
        text,
        reply_markup: markup(buttons),
        link_preview_options: { is_disabled: true },
      });
      return result.message_id;
    },
    async edit(messageId, { text, buttons }) {
      await call("editMessageText", {
        chat_id: chat_id(),
        message_id: messageId,
        text,
        reply_markup: markup(buttons),
        link_preview_options: { is_disabled: true },
      });
    },
  };
}

// One pass: post new open items, edit messages whose item changed.
export async function syncQueue(store, bot, capture = captureOwnerText) {
  store.reconcile();
  for (const item of store.unrendered()) {
    const message = itemMessage(item);
    let telegramId = item.telegramId;
    if (telegramId) {
      try {
        await bot.edit(telegramId, message);
      } catch (e) {
        if (/not modified/.test(e.message)) {
          /* Already shows this text. */
        } else if (/not found|can't be edited/.test(e.message))
          telegramId = null;
        else throw e;
      }
    }
    if (!telegramId) {
      telegramId = await bot.send(message);
      capture(message.text, telegramId);
    }
    store.markRendered(item.id, item.version, telegramId);
  }
}

function fromOwner(ctx, ownerId) {
  return String(ctx.senderId ?? "") === String(ownerId);
}
export async function handleButton(ctx, review, ownerId, sync) {
  if (ctx.isGroup || !ctx.auth?.isAuthorizedSender || !fromOwner(ctx, ownerId))
    return { handled: true };
  const [op, id, version] = ctx.callback.payload.split(":");
  try {
    if (op === "o") await review.open(id, Number(version));
    else if (op === "x") review.reject(id, Number(version));
    else return { handled: true };
  } catch (e) {
    await ctx.respond.reply({ text: e.message });
  }
  await sync();
  return { handled: true };
}
// A reply to an open question is the answer to it.
export async function handleReply(event, ctx, review, ownerId, sync) {
  if (event.channel !== "telegram" || event.isGroup) return;
  if (!fromOwner({ senderId: event.senderId ?? ctx.senderId }, ownerId)) return;
  const replyTo = Number(event.replyToId ?? ctx.replyToId);
  if (!replyTo) return;
  const item = review.store.byTelegramId(replyTo);
  if (item?.state !== "needs_info") return;
  try {
    await review.answer(item.id, item.version, event.content);
  } catch (e) {
    return { handled: true, text: e.message };
  }
  await sync();
  return { handled: true, text: "Got it. I'll post the next step here." };
}

export function registerTelegramQueue(api, getReview) {
  const bot = telegramBot(api.config);
  const ownerId = () => ownerProfile().telegramUserId;
  let running = null,
    lastError = "",
    timer;
  const sync = () =>
    (running ??= syncQueue(getReview().store, bot)
      .then(() => (lastError = ""))
      .catch((e) => {
        if (e.message !== lastError)
          api.logger.warn("Review queue Telegram sync failed: " + e.message);
        lastError = e.message;
      })
      .finally(() => (running = null)));
  api.registerInteractiveHandler({
    channel: "telegram",
    namespace: NAMESPACE,
    handler: (ctx) => handleButton(ctx, getReview(), ownerId(), sync),
  });
  api.on("before_dispatch", (event, ctx) =>
    handleReply(event, ctx, getReview(), ownerId(), sync),
  );
  api.registerService({
    id: "secretary-review-telegram",
    start() {
      timer = setInterval(sync, 5000);
      sync();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  });
}
