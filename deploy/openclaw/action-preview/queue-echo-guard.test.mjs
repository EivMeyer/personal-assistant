import test from "node:test";
import assert from "node:assert/strict";
import { QueueEchoGuard } from "./queue-echo-guard.mjs";

const heartbeat = { sessionKey: "agent:main:main:heartbeat", sessionId: "s1" };
const reply = (text, extra = {}) => ({
  ...heartbeat,
  lastAssistantMessage: text,
  ...extra,
});

test("a background reply after staging gets one rewrite, then is accepted", () => {
  const guard = new QueueEchoGuard();
  guard.staged(heartbeat);
  const result = guard.check(reply("A guest asks for the check-in time."), {});
  assert.equal(result.action, "revise");
  assert.equal(result.retry.maxAttempts, 1);
  assert.match(result.retry.instruction, /HEARTBEAT_OK/);
  assert.equal(
    guard.check(reply("A colleague changed tomorrow's plan."), {}),
    undefined,
  );
});

test("quiet replies, runs without staging and owner chats are left alone", () => {
  const guard = new QueueEchoGuard();
  guard.staged(heartbeat);
  assert.equal(guard.check(reply("HEARTBEAT_OK"), {}), undefined);
  assert.equal(guard.check(reply("A new notice."), {}), undefined);
  const direct = { sessionKey: "agent:main:main", sessionId: "s2" };
  guard.staged(direct);
  assert.equal(
    guard.check({ ...direct, lastAssistantMessage: "Staged it." }, {}),
    undefined,
  );
  guard.staged(heartbeat);
  assert.equal(
    guard.check(reply(undefined), {}),
    undefined,
    "no final text means nothing to compare",
  );
});

test("marks are per run and expire after the background budget", () => {
  let now = 0;
  const guard = new QueueEchoGuard(() => now);
  guard.staged({ ...heartbeat, sessionId: undefined });
  now = 7 * 60_000;
  assert.equal(guard.check(reply("Stale."), {}), undefined);
  guard.staged(heartbeat);
  assert.equal(
    guard.check(reply("Echo.", { sessionKey: undefined }), heartbeat).action,
    "revise",
  );
});
