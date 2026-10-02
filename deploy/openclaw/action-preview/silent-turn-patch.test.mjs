import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { patchSilentTurn } from "./silent-turn-patch.mjs";

// The reviewed upstream function. Execute the patched function, including its
// existing failure checks, rather than merely asserting replacement text.
const original = `function shouldTreatEmptyAssistantReplyAsSilent(params) {
 const completion = resolveReplyCompletion(resolveReplyExpectation(params), params.payloadCount === 0 ? "empty" : "ready");
 const assistant = classifyAssistantTurn(params);
 return completion.outcome === "silent" && !shouldSkipNonVisibleTurnRetry({
\t\t...params,
\t\ttolerateSideEffects: true
 }) && resolveSourceReplyDelivery(params.attempt) === "missing" && (!params.onlyExplicitSilentReply || assistant.silent) && assistant.nonVisibleEligibleForSilentReply;
}`;
const context = vm.createContext({
  resolveReplyExpectation: (p) => p.terminalReplyExpectation,
  resolveReplyCompletion: (expectation, output) => ({
    outcome:
      expectation === "optional" && output === "empty" ? "silent" : "required",
  }),
  classifyAssistantTurn: (p) => ({
    silent: p.attempt.text === "NO_REPLY",
    assistant: p.attempt.assistant,
    nonVisibleEligibleForSilentReply:
      !p.attempt.text || p.attempt.text === "NO_REPLY",
  }),
  shouldSkipNonVisibleTurnRetry: (p) =>
    Boolean(
      p.aborted ||
      p.timedOut ||
      p.attempt.terminal.kind === "failed" ||
      p.attempt.lastToolError ||
      p.attempt.activeTools ||
      p.attempt.pendingApproval,
    ),
  resolveSourceReplyDelivery: () => "missing",
});
vm.runInContext(patchSilentTurn(original), context);
const quiet = {
  terminalReplyExpectation: "optional",
  payloadCount: 0,
  attempt: {
    text: "NO_REPLY",
    assistant: { stopReason: "stop" },
    terminal: { kind: "completed" },
    lastToolError: { toolName: "cron" },
  },
};
test("explicit quiet completion accepts a handled tool error without mutating evidence", () => {
  assert.equal(context.shouldTreatEmptyAssistantReplyAsSilent(quiet), true);
  assert.equal(quiet.attempt.lastToolError.toolName, "cron");
});
test("actual failures and unfinished work are never converted to silent success", () => {
  for (const change of [
    { aborted: true },
    { timedOut: true },
    { terminalReplyExpectation: "required" },
    { payloadCount: 1 },
    ...[
      { text: "" },
      { text: "A real answer" },
      { terminal: { kind: "failed" } },
      { activeTools: 1 },
      { pendingApproval: true },
      { assistant: { stopReason: "toolUse" } },
    ].map((a) => ({ attempt: { ...quiet.attempt, ...a } })),
  ])
    assert.equal(
      context.shouldTreatEmptyAssistantReplyAsSilent({ ...quiet, ...change }),
      false,
    );
});
test("silent patch is idempotent and rejects upstream drift", () => {
  const patched = patchSilentTurn(original);
  assert.equal(patchSilentTurn(patched), patched);
  assert.throws(() => patchSilentTurn("changed upstream"), /Unexpected/);
});
