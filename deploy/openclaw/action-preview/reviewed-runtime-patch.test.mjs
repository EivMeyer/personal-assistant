import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySilentTurnPatch } from "./silent-turn-patch.mjs";
const original = `function shouldTreatEmptyAssistantReplyAsSilent(params) {
return completion.outcome === "silent" && !shouldSkipNonVisibleTurnRetry({
\t\t...params,
\t\ttolerateSideEffects: true
});
}`;
test("installer selects the actual policy bundle, preserves the original and refuses version drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "secretary-runtime-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), '{"version":"2026.9.6"}');
  const file = join(root, "dist/builtin-openclaw-main.mjs");
  writeFileSync(file, original);
  writeFileSync(join(root, "dist/builtin-openclaw-other.mjs"), "other export");
  assert.equal(applySilentTurnPatch(root), true);
  assert.equal(readFileSync(file + ".secretary-original", "utf8"), original);
  assert.equal(applySilentTurnPatch(root), false);
  writeFileSync(join(root, "package.json"), '{"version":"2099.1.1"}');
  assert.throws(() => applySilentTurnPatch(root), /reviewed/);
});
