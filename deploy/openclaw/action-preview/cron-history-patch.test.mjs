import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { patchCronHistory } from "./cron-history-patch.mjs";

test("history is eligible for the existing owner grant without admitting new callers", () => {
  const original = `const CRON_MANAGEMENT_METHODS = [\n\t"cron.list",\n\t"cron.get",\n\t"cron.update",\n\t"cron.run",\n\t"cron.remove"\n];
    function mint(owner, method) {
      if (!owner || !owner.active || !CRON_MANAGEMENT_METHODS.includes(method)) return;
      return { runId: owner.runId, method };
    }
    globalThis.mint = mint;`;
  const context = vm.createContext({});
  vm.runInContext(patchCronHistory(original, "grant"), context);
  assert.equal(context.mint(undefined, "cron.runs"), undefined);
  assert.equal(context.mint({ active: false }, "cron.runs"), undefined);
  assert.equal(
    context.mint({ active: true, runId: "owner" }, "cron.runs").runId,
    "owner",
  );
  assert.equal(context.mint({ active: true }, "cron.add"), undefined);
});
test("history revalidates authority before returning and patch rejects drift", () => {
  const source =
    'if (method === "cron.list" || method === "cron.get") { assertActive(); }';
  const patched = patchCronHistory(source, "handler");
  assert.match(patched, /method === "cron.runs"/);
  assert.match(patched, /assertActive/);
  assert.equal(patchCronHistory(patched, "handler"), patched);
  assert.throws(
    () => patchCronHistory("changed upstream", "handler"),
    /Unexpected/,
  );
});
