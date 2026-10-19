import { reviewCommand } from "./review-command.mjs";
import { ActionStore } from "./action-store.mjs";
import { ReviewService } from "./review-service.mjs";
import { registerReviewTools } from "./review-tools.mjs";
import { registerTelegramQueue } from "./review-telegram.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ownerProfile } from "./owner-profile.mjs";

export function ownerCommand(ctx, ownerId) {
  if (
    ctx.channel !== "telegram" ||
    !ctx.isAuthorizedSender ||
    String(ctx.senderId) !== ownerId
  )
    throw Error("This queue belongs to the verified Telegram owner.");
  ctx.assertOwnerCurrent?.();
}
// The review queue lives in the owner's Telegram chat; there is no other UI.
export function registerReviewQueue(api, { home = homedir(), onStaged } = {}) {
  let review, actions;
  const getReview = () =>
    (review ??= new ReviewService({
      actions: (actions ??= new ActionStore(
        join(home, ".local/share/secretary-actions/actions.sqlite"),
      )),
      config: api.config,
    }));
  registerReviewTools(api, getReview, onStaged);
  registerTelegramQueue(api, getReview);
  api.registerCommand({
    name: "inbox",
    description: "List what is waiting on you, or open /inbox review ITEM_ID",
    channels: ["telegram"],
    acceptsArgs: true,
    requireAuth: true,
    handler(ctx) {
      try {
        ownerCommand(ctx, ownerProfile().telegramUserId);
        return reviewCommand(ctx, getReview());
      } catch (e) {
        return { text: e.message };
      }
    },
  });
  api.registerService({
    id: "secretary-review-store",
    start() {},
    stop() {
      actions?.close();
      actions = undefined;
      review = undefined;
    },
  });
}
