import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { monitorInstructions } from "./monitor-policy.mjs";
test("packaged monitor contains the full workspace policy", () => {
  const template = readFileSync(
    new URL("../workspace/HEARTBEAT.md", import.meta.url),
    "utf8",
  );
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  assert.equal(normalize(monitorInstructions), normalize(template));
});
test("monitor loads from an isolated plugin package without sibling workspace files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "secretary-packaged-monitor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["incoming-context.mjs", "monitor-policy.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(directory, name));
  const url = pathToFileURL(join(directory, "incoming-context.mjs")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import(" + JSON.stringify(url) + ")",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
