import { pathToFileURL } from "node:url";
import { installReviewedPatch } from "./reviewed-runtime-patch.mjs";
const marker = "// secretary: defer background checks across host suspension";
export function patchHeartbeatResume(source, moduleUrl) {
  if (source.startsWith(marker)) return source;
  const replacements = [
    [
      "async function runHeartbeatOnce(opts) {",
      'async function runHeartbeatOnce(opts) {\n\tif (!await heartbeatAvailability.ready()) return { status: "skipped", reason: "channel-not-ready" };',
    ],
    [
      "const signal = getSessionEventWakeAbortSignal();",
      "const secretaryLease = heartbeatAvailability.lease(getSessionEventWakeAbortSignal());\n\tconst signal = secretaryLease.signal;",
    ],
    [
      "dispatcherOptions: { deliver: (payload) => deliverHeartbeatDispatch(policy, payload, state.agentTurnOwner?.abortSignal ?? signal) }",
      "dispatcherOptions: { deliver: (payload) => secretaryLease.suspended() ? Promise.resolve() : deliverHeartbeatDispatch(policy, payload, state.agentTurnOwner?.abortSignal ?? signal) }",
    ],
    [
      "\t\tif (policy.result) return policy.result;",
      '\t\tif (secretaryLease.suspended()) return { status: "skipped", reason: "channel-not-ready" };\n\t\tif (policy.result) return policy.result;',
    ],
    [
      "\t\ttyping?.onCleanup?.();",
      "\t\tsecretaryLease.dispose();\n\t\ttyping?.onCleanup?.();",
    ],
  ];
  for (const [before, after] of replacements) {
    const expected = before.includes("policy.result") ? 2 : 1;
    if (source.split(before).length !== expected + 1)
      throw Error(
        "Unexpected heartbeat implementation; review before patching",
      );
    source = source.replaceAll(before, after);
  }
  return (
    marker +
    "\nimport { heartbeatAvailability } from " +
    JSON.stringify(moduleUrl) +
    ";\n" +
    source
  );
}
export function applyHeartbeatResumePatch(root) {
  return installReviewedPatch(root, {
    pattern: /^heartbeat-runner-run-[\w-]+\.mjs$/,
    contains: "async function runHeartbeatOnce(opts)",
    patch: (source) =>
      patchHeartbeatResume(
        source,
        new URL("./heartbeat-availability.mjs", import.meta.url).href,
      ),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applyHeartbeatResumePatch(process.argv[2]) }),
  );
