import test from "node:test";
import assert from "node:assert/strict";
import { healthAlert, backgroundToolWarning } from "./health-alerts.mjs";
const event = {
  to: "700000001",
  content:
    "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.",
};
const ctx = { channelId: "telegram" };
test("background alerts are honest and deduplicated, without hiding other errors", () => {
  assert.match(
    healthAlert(event, ctx, undefined, 100).content,
    /may still be waiting/,
  );
  assert.equal(healthAlert(event, ctx, 100, 200).cancel, true);
  assert.ok(healthAlert(event, ctx, 100, 3_600_101).content);
  assert.equal(
    healthAlert({ ...event, content: "Send outcome unknown" }, ctx, 100, 200),
    undefined,
  );
  assert.equal(
    healthAlert({ ...event, to: "other" }, ctx, 100, 200),
    undefined,
  );
});
test("bare tool notices from background runs are dropped, real failures still arrive", () => {
  const background = {
    channelId: "telegram",
    sessionKey: "agent:main:main:heartbeat",
  };
  const notice = (content) => ({ to: "telegram:700000001", content });
  for (const content of [
    "⚠️ Slack-media Media failed",
    "⚠️ Secretary Review failed",
    "⚠️ Slack Conversations Search Messages failed: rate limited",
    "⚠️ Exec failed (exit 1)",
    "⚠️ Gmail Read timed out after 30s.",
    "⚠️ Whatsapp-structured Media blocked",
  ])
    assert.equal(
      backgroundToolWarning(notice(content), background)?.cancel,
      true,
      content,
    );
  for (const content of [
    "⚠️ Agent run failed: the model login expired",
    "⚠️ Model login failed",
    "⚠️ LLM connection failed",
    "⚠️ Heartbeat check failed before it could produce an update.",
    '⚠️ Plugin "secretary-action-preview" failed to load: reason',
    "⚠️ Slack-media Media failed\nmore detail",
    "A guest asks for the check-in time.",
  ])
    assert.equal(
      backgroundToolWarning(notice(content), background),
      undefined,
      content,
    );
  const toolNotice = notice("⚠️ Slack-media Media failed");
  for (const ctx of [
    { channelId: "telegram", sessionKey: "agent:main:main" },
    { channelId: "telegram" },
    { ...background, channelId: "slack" },
  ])
    assert.equal(backgroundToolWarning(toolNotice, ctx), undefined);
  assert.equal(
    backgroundToolWarning({ ...toolNotice, to: "other" }, background),
    undefined,
  );
});
