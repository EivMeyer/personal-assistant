import test from "node:test";
import assert from "node:assert/strict";
import { recoveryDecision } from "./recovery-watch.mjs";
const now = 1_000_000;
const healthy = {
  ok: true,
  channels: {
    telegram: {
      running: true,
      connected: true,
      lifecycle: "ready",
      lastTransportActivityAt: now,
    },
  },
};
const base = { now, state: {}, active: 0, networkReady: true };
test("live recovery suppresses restarts after a transient binding error", () => {
  assert.deepEqual(
    recoveryDecision({
      ...base,
      health: healthy,
      state: { unhealthySince: 1 },
    }),
    {
      action: "healthy",
      state: { lastRestart: 0 },
    },
  );
});
test("offline and fresh startup do not cause restart storms", () => {
  assert.equal(recoveryDecision({ ...base }).action, "wait");
  const offline = recoveryDecision({
    ...base,
    networkReady: false,
    state: { unhealthySince: 1 },
  });
  assert.equal(offline.action, "offline");
  assert.equal(offline.state.unhealthySince, null);
  assert.equal(
    recoveryDecision({ ...base, state: offline.state }).action,
    "wait",
  );
});
test("persistent live failure restarts only after grace, action completion and cooldown", () => {
  const state = { unhealthySince: now - 120_001 };
  assert.equal(recoveryDecision({ ...base, state }).action, "restart");
  assert.equal(recoveryDecision({ ...base, state, active: 1 }).action, "wait");
  assert.equal(
    recoveryDecision({
      ...base,
      state: { ...state, lastRestart: now - 10_000 },
    }).action,
    "wait",
  );
});
test("stale connected status is not proof of recovery", () => {
  const health = structuredClone(healthy);
  health.channels.telegram.lastTransportActivityAt = now - 100_000;
  assert.equal(
    recoveryDecision({ ...base, health, state: { unhealthySince: 1 } }).action,
    "restart",
  );
});
