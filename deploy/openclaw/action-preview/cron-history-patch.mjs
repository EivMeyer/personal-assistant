import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "// secretary: authenticated reminder history grant";
export function patchCronHistory(source, kind) {
  if (source.startsWith(MARKER)) return source;
  const before =
    kind === "grant"
      ? '\t"cron.get",\n'
      : 'if (method === "cron.list" || method === "cron.get") {';
  const after =
    kind === "grant"
      ? '\t"cron.get",\n\t"cron.runs",\n'
      : 'if (method === "cron.list" || method === "cron.get" || method === "cron.runs") {';
  if (!["grant", "handler"].includes(kind) || source.split(before).length !== 2)
    throw Error("Unexpected cron implementation; review before patching");
  return MARKER + "\n" + source.replace(before, after);
}
export function applyCronHistoryPatch(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== "2026.9.6")
    throw Error("Cron patch only reviewed for OpenClaw 2026.9.6");
  const directory = join(root, "dist");
  const changes = [
    ["grant", /^cron-creator-authority-grant-[\w-]+\.mjs$/],
    ["handler", /^cron-[\w]+\.mjs$/],
  ].map(([kind, pattern]) => {
    const files = readdirSync(directory).filter((name) => pattern.test(name));
    const matches = files.filter((name) =>
      readFileSync(join(directory, name), "utf8").includes(
        kind === "grant"
          ? "const CRON_MANAGEMENT_METHODS"
          : '"cron.runs": async',
      ),
    );
    if (matches.length !== 1)
      throw Error("Expected one cron module for " + kind);
    const path = join(directory, matches[0]);
    const source = readFileSync(path, "utf8");
    return { path, source, patched: patchCronHistory(source, kind) };
  });
  for (const { path, source, patched } of changes) {
    if (source === patched) continue;
    if (!existsSync(path + ".secretary-original"))
      writeFileSync(path + ".secretary-original", source, { mode: 0o600 });
    writeFileSync(path, patched);
  }
  return changes.filter(({ source, patched }) => source !== patched).length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applyCronHistoryPatch(process.argv[2]) }),
  );
