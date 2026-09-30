import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "// secretary: bounded helpers must use Astra/high";
export function patchBoundedTurn(source) {
  if (source.includes(MARKER)) return source;
  const selection = "selection: params.model,";
  const effort =
    'effort: params.thinkLevel === void 0 ? "low" : resolveCodexAppServerReasoningEffort({';
  if (source.split(selection).length !== 2 || source.split(effort).length !== 2)
    throw Error(
      "Unexpected Codex bounded-turn implementation; review before patching",
    );
  const originalReasoning =
    /effort: params\.thinkLevel === void 0 \? "low" : resolveCodexAppServerReasoningEffort\(\{[\s\S]*?\}\)(,?)/;
  if (!originalReasoning.test(source))
    throw Error("Unexpected reasoning expression");
  return source
    .replace(selection, 'selection: { mode: "required", id: "gpt-6-astra" },')
    .replace(originalReasoning, 'effort: "high"$1');
}
export function applyRuntimePatch(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== "2026.9.6")
    throw Error("Runtime patch only reviewed for @openclaw/codex 2026.9.6");
  const directory = join(root, "dist/.setup");
  const files = readdirSync(directory).filter((name) =>
    /^bounded-turn-.*\.mjs$/.test(name),
  );
  if (files.length !== 1) throw Error("Expected one bounded-turn module");
  const path = join(directory, files[0]);
  const source = readFileSync(path, "utf8");
  const patched = patchBoundedTurn(source);
  if (patched === source) return false;
  if (!existsSync(path + ".secretary-original"))
    writeFileSync(path + ".secretary-original", source, { mode: 0o600 });
  writeFileSync(path, MARKER + "\n" + patched);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ patched: applyRuntimePatch(process.argv[2]) }));
