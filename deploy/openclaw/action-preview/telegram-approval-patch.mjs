import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const MARKER = "// secretary: plain-language Telegram approval presentation";
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error("Unexpected Telegram approval implementation");
  return source.replace(before, after);
}
export function patchTelegramApproval(source, helperUrl) {
  if (source.startsWith(MARKER)) return source;
  const start = "function buildPendingPayload(params) {\n";
  source = replaceOnce(
    source,
    start,
    start +
      `\tif (isSecretaryApproval(params.view)) return {\n\t\ttext: "Go ahead with the action above?",\n\t\tbuttons: resolveTelegramInlineButtons({ presentation: buildApprovalPresentationFromActionDescriptors(secretaryApprovalActions(params.view)) })\n\t};\n`,
  );
  source = replaceOnce(
    source,
    "text: buildTelegramNativeResolvedApprovalText(view)",
    "text: secretaryApprovalStatus(view) ?? buildTelegramNativeResolvedApprovalText(view)",
  );
  source = replaceOnce(
    source,
    "text: buildTelegramNativeExpiredApprovalText(view)",
    "text: secretaryApprovalStatus(view) ?? buildTelegramNativeExpiredApprovalText(view)",
  );
  return (
    MARKER +
    "\nimport { isSecretaryApproval, secretaryApprovalActions, secretaryApprovalStatus } from " +
    JSON.stringify(helperUrl) +
    ";\n" +
    source
  );
}
export function applyTelegramApprovalPatch(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== "2026.9.6")
    throw Error("Telegram approval patch only reviewed for OpenClaw 2026.9.6");
  const directory = join(root, "dist");
  const files = readdirSync(directory).filter((name) =>
    /^approval-handler\.runtime-[\w-]+\.mjs$/.test(name),
  );
  if (files.length !== 1) throw Error("Expected one Telegram approval module");
  const path = join(directory, files[0]);
  const source = readFileSync(path, "utf8");
  const patched = patchTelegramApproval(
    source,
    new URL("./telegram-approval-copy.mjs", import.meta.url).href,
  );
  if (source === patched) return false;
  if (!existsSync(path + ".secretary-original"))
    writeFileSync(path + ".secretary-original", source, { mode: 0o600 });
  writeFileSync(path, patched);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applyTelegramApprovalPatch(process.argv[2]) }),
  );
