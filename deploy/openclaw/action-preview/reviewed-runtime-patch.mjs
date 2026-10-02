import { readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
export function installReviewedPatch(root, spec) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== "2026.9.6")
    throw Error("Runtime patch only reviewed for OpenClaw 2026.9.6");
  const dir = join(root, "dist");
  const files = readdirSync(dir).filter(
    (name) =>
      spec.pattern.test(name) &&
      readFileSync(join(dir, name), "utf8").includes(spec.contains),
  );
  if (files.length !== 1)
    throw Error("Expected one reviewed module: " + spec.contains);
  const file = join(dir, files[0]);
  const before = readFileSync(file, "utf8");
  const after = spec.patch(before);
  if (before === after) return false;
  try {
    writeFileSync(file + ".secretary-original", before, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const next = file + ".secretary-next";
  writeFileSync(next, after, { mode: 0o600 });
  renameSync(next, file);
  return true;
}
