import test from "node:test";
import assert from "node:assert/strict";
import { createHeartbeatAvailability } from "./heartbeat-availability.mjs";
function harness() {
  let time = 0,
    online = true;
  const gate = createHeartbeatAvailability({
    now: () => time,
    probe: async () => online,
  });
  return {
    gate,
    online(value) {
      online = value;
    },
    advance(ms) {
      time += ms;
    },
    stable(ms) {
      for (let i = 0; i < ms; i += 1000) {
        time += 1000;
        gate.tick();
      }
    },
  };
}
test("startup and resume wait for stable online time without consuming work", async () => {
  const h = harness();
  assert.equal(await h.gate.ready(), false);
  h.stable(30000);
  assert.equal(await h.gate.ready(), true);
  h.online(false);
  assert.equal(await h.gate.ready(), false);
  h.online(true);
  const lease = h.gate.lease();
  h.advance(3600000);
  assert.equal(lease.suspended(), true);
  assert.equal(lease.signal.aborted, true);
  assert.equal(await h.gate.ready(), false);
  h.stable(30000);
  assert.equal(await h.gate.ready(), true);
  lease.dispose();
});
test("normal execution and unrelated parent abort are not classified as suspension", () => {
  const h = harness();
  const parent = new AbortController();
  const lease = h.gate.lease(parent.signal);
  h.stable(240000);
  assert.equal(lease.suspended(), false);
  parent.abort();
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.suspended(), false);
  lease.dispose();
});
