import { installReviewedPatch } from "./reviewed-runtime-patch.mjs";
import { pathToFileURL } from "node:url";

const MARKER = "// secretary: separate gateway Mini App from session dashboard";
export function patchTelegramMenu(source) {
  if (source.startsWith(MARKER)) return source;
  const before = `function createTelegramMiniAppDashboardCommand(api, launchTickets) {
\treturn {
\t\tname: "dashboard",`;
  if (source.split(before).length !== 2)
    throw Error("Unexpected Telegram Mini App command; review before patching");
  return (
    MARKER +
    "\n" +
    source.replace(before, before.replace('"dashboard"', '"gateway_dashboard"'))
  );
}
export function applyTelegramMenuPatch(root) {
  return installReviewedPatch(root, {
    pattern: /^miniapp-api-[\w-]+\.mjs$/,
    contains:
      "function createTelegramMiniAppDashboardCommand(api, launchTickets)",
    patch: patchTelegramMenu,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applyTelegramMenuPatch(process.argv[2]) }),
  );
