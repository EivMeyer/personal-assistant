import { pathToFileURL } from "node:url";
import { installReviewedPatch } from "./reviewed-runtime-patch.mjs";
const MARKER =
  "// secretary: classify package installs without a Git subprocess";
export function patchPackageInstall(source) {
  if (source.startsWith(MARKER)) return source;
  const before =
    '\tif (!root) return "unknown";\n\tconst result = await runUpdateGitCommand(root, ["rev-parse", "--show-toplevel"], {';
  const after =
    '\tif (!root) return "unknown";\n\tif (!await exists(path.join(root, ".git")) && await readPackageName(root) === PUBLIC_NPM_PACKAGE_NAME) {\n\t\toptions.signal?.throwIfAborted();\n\t\treturn "package";\n\t}\n\tconst result = await runUpdateGitCommand(root, ["rev-parse", "--show-toplevel"], {';
  if (source.split(before).length !== 2)
    throw Error(
      "Unexpected package detection implementation; review before patching",
    );
  return MARKER + "\n" + source.replace(before, after);
}
export function applyPackageInstallPatch(root) {
  return installReviewedPatch(root, {
    pattern: /^update-check-[\w-]+\.mjs$/,
    contains: "async function resolveUpdateInstallKind",
    patch: patchPackageInstall,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applyPackageInstallPatch(process.argv[2]) }),
  );
