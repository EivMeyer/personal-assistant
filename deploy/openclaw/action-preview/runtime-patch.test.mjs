import test from "node:test";
import assert from "node:assert/strict";
import { patchBoundedTurn } from "./runtime-patch.mjs";
test("bounded helper patch pins model and reasoning and rejects upstream drift", () => {
  const original = `selection: params.model,
    effort: params.thinkLevel === void 0 ? "low" : resolveCodexAppServerReasoningEffort({
      modelId: modelSelection.model, thinkLevel: params.thinkLevel
    })`;
  const patched = patchBoundedTurn(original);
  assert.match(patched, /mode: "required", id: "gpt-6-astra"/);
  assert.match(patched, /effort: "high"/);
  assert.doesNotMatch(patched, /"low"/);
  assert.throws(() => patchBoundedTurn("changed upstream code"), /Unexpected/);
  assert.equal(
    patchBoundedTurn(
      "// secretary: bounded helpers must use Astra/high\n" + patched,
    ),
    "// secretary: bounded helpers must use Astra/high\n" + patched,
  );
});
