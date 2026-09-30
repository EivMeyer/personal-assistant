import test from "node:test";
import assert from "node:assert/strict";
import { VisibleConversation, promptForTurn } from "./conversation-context.mjs";
const ctx = {
  channelId: "telegram",
  conversationId: "700000001",
  senderId: "700000001",
};
const agent = { agentId: "main", channel: "telegram", senderId: "700000001" };
test("only delivered owner-visible messages enter conversation context", () => {
  const c = new VisibleConversation(":memory:");
  try {
    const outgoing = {
      to: "700000001",
      content: "Should I schedule the email reminder?",
      messageId: "20",
      success: true,
    };
    assert.equal(
      c.capture("assistant", { ...outgoing, success: false }, ctx),
      false,
    );
    assert.equal(
      c.capture("assistant", { ...outgoing, content: "NO_REPLY" }, ctx),
      false,
    );
    assert.equal(
      c.capture("assistant", outgoing, { ...ctx, channelId: "whatsapp" }),
      false,
    );
    assert.equal(
      c.capture(
        "user",
        { content: "foreign", messageId: "21", senderId: "other" },
        ctx,
      ),
      false,
    );
    c.capture("assistant", outgoing, ctx);
    c.capture("assistant", outgoing, ctx);
    assert.equal(c.recent().length, 1);
  } finally {
    c.close();
  }
});
test("email follow-up stays attached to visible proposal despite background WhatsApp chatter", () => {
  const c = new VisibleConversation(":memory:");
  try {
    c.capture(
      "assistant",
      {
        to: "700000001",
        content: "An email asks for a reminder. Should I schedule it?",
        messageId: "20",
        success: true,
      },
      ctx,
    );
    c.capture(
      "user",
      {
        from: "700000001",
        content: "Reply that I do not want to do it",
        messageId: "22",
        replyToId: "20",
      },
      ctx,
    );
    const result = promptForTurn(
      {
        currentUserMessage: "Reply that I do not want to do it",
        prompt: "Background: checking a WhatsApp message",
      },
      agent,
      c,
    );
    assert.ok(result.prependContext.includes("An email asks"));
    assert.ok(result.prependContext.includes('"replyTo":"20"'));
    assert.ok(!result.prependContext.includes("Background: checking"));
    assert.equal(
      promptForTurn({}, { ...agent, trigger: "heartbeat" }, c),
      undefined,
    );
    assert.equal(
      promptForTurn({}, { ...agent, senderId: "other" }, c),
      undefined,
    );
  } finally {
    c.close();
  }
});
