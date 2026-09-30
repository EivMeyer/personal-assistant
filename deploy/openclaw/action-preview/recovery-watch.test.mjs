import test from "node:test";
import assert from "node:assert/strict";
import { shouldRecover, recoverGateway } from "./recovery-watch.mjs";
const now = Date.parse("2026-09-24T21:28:00+02:00");
const lines = [
  "2026-09-24T21:27:00.863+02:00 [telegram] Conversation binding owner changed while preparing the reply.",
  "2026-09-24T21:27:01.863+02:00 [heartbeat] Session binding owner changed for telegram:default",
];
test("persistent binding failure triggers recovery, old errors and one transient do not", () => {
  assert.equal(shouldRecover({ lines, now }), true);
  assert.equal(shouldRecover({ lines: lines.slice(0, 1), now }), false);
  assert.equal(shouldRecover({ lines, now: now + 180_000 }), false);
  assert.equal(shouldRecover({ lines, now: now - 180_000 }), false);
});
test("recovery waits for actions and enforces a persistent cooldown", () => {
  assert.equal(shouldRecover({ lines, now, activeActions: 1 }), false);
  assert.equal(shouldRecover({ lines, now, lastRestart: now - 10_000 }), false);
  const calls = [];
  recoverGateway({
    lines,
    now,
    state: {},
    active: 0,
    save: (state) => calls.push(state),
    restart: () => calls.push("restart"),
  });
  assert.deepEqual(calls, [{ lastRestart: now }, "restart"]);
});
