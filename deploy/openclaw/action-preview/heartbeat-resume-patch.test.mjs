import test from "node:test";
import assert from "node:assert/strict";
import { patchHeartbeatResume } from "./heartbeat-resume-patch.mjs";
const source = `async function runHeartbeatOnce(opts) {
 const signal = getSessionEventWakeAbortSignal();
 try {
 const config = { dispatcherOptions: { deliver: (payload) => deliverHeartbeatDispatch(policy, payload, state.agentTurnOwner?.abortSignal ?? signal) } };
\t\tif (policy.result) return policy.result;
 } catch (error) {
\t\tif (policy.result) return policy.result;
 } finally {
\t\ttyping?.onCleanup?.();
 }
}`;
test("resume patch guards preflight, cancellation, stale delivery and both result paths", () => {
  const patched = patchHeartbeatResume(
    source,
    "file:///fixture/heartbeat-availability.mjs",
  );
  assert.match(patched, /heartbeatAvailability.ready/);
  assert.match(patched, /const signal = secretaryLease.signal/);
  assert.equal(patched.match(/secretaryLease.suspended\(\)/g).length, 3);
  assert.match(patched, /secretaryLease.dispose/);
  assert.match(patched, /payload.isError/);
  assert.equal(patched.match(/heartbeatAvailability.failed\(\)/g).length, 2);
  assert.equal(patchHeartbeatResume(patched, "unused"), patched);
  assert.throws(
    () =>
      patchHeartbeatResume(
        source.replace("const signal =", "let signal ="),
        "unused",
      ),
    /Unexpected/,
  );
});
