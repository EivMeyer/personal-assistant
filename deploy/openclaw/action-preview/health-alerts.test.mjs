import test from "node:test";
import assert from "node:assert/strict";
import { healthAlert } from "./health-alerts.mjs";
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
