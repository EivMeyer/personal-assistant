import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { TelegramController } from "../src/telegram-controller.ts";
import { FakeMessenger, harness } from "./helpers.ts";
import type { TelegramUpdate } from "../src/adapters/telegram.ts";

function callback(id: string, userId = 7, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: "callback",
      from: { id: userId },
      data: `approve:${id}:1`,
      message: { message_id: 1, chat: { id: 7, type: "private" } },
    },
  };
}
test("only owner in the exact private chat can approve a registered card", async (t) => {
  const { h, controller } = telegramHarness(t);
  const p = await h.propose();
  await controller.deliver();
  await controller.handle(callback(p.id, 99));
  assert.equal(h.source.sends.length, 0);
  const group = callback(p.id, 7, 2);
  group.callback_query!.message!.chat.type = "group";
  await controller.handle(group);
  assert.equal(h.source.sends.length, 0);
  await controller.handle(callback(p.id, 7, 3));
  await controller.handle(callback(p.id, 7, 3));
  assert.equal(h.source.sends.length, 1);
});
test("plain yes cannot approve and unrelated replies cannot edit", async (t) => {
  const { h, controller } = telegramHarness(t);
  await h.propose();
  await controller.deliver();
  await controller.handle(ownerText("yes"));
  assert.equal(h.source.sends.length, 0);
  assert.equal(h.planner.calls, 1);
});
test("reply correction creates a new card and never sends", async (t) => {
  const { h, controller } = telegramHarness(t);
  const p = await h.propose();
  await controller.deliver();
  await controller.handle(ownerText("Friday", 1));
  assert.equal(h.store.proposal(p.id)?.version, 2);
  assert.equal(h.source.sends.length, 0);
  await controller.handle(callback(p.id, 7, 2));
  assert.equal(h.source.sends.length, 0);
});
test("outbox delivery retries persist and obsolete cards are dropped", async (t) => {
  const { h, bot, controller } = telegramHarness(t);
  bot.failures = 1;
  const p = await h.propose();
  await controller.deliver();
  assert.equal(bot.messages.length, 0);
  h.advance(20_000);
  await controller.deliver();
  assert.equal(bot.messages.length, 1);
  await h.engine.correct(p.id, 1, "Friday");
  h.engine.dismiss(p.id, 2, "skip");
  await controller.deliver();
  assert.equal(bot.messages.length, 1);
});

function telegramHarness(t: TestContext) {
  const h = harness();
  t.after(h.close);
  const bot = new FakeMessenger();
  const controller = new TelegramController(h.engine, bot, {
    userId: 7,
    chatId: 7,
  });
  return { h, bot, controller };
}
function ownerText(text: string, replyTo?: number): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 2,
      from: { id: 7 },
      chat: { id: 7, type: "private" },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}
