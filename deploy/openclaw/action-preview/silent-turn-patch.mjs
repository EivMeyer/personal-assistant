import { installReviewedPatch } from "./reviewed-runtime-patch.mjs";
import { pathToFileURL } from "node:url";

const MARKER =
  "// secretary: explicit quiet completion survives handled tool errors";
export function patchSilentTurn(source) {
  if (source.startsWith(MARKER)) return source;
  const before = `return completion.outcome === "silent" && !shouldSkipNonVisibleTurnRetry({
\t\t...params,
\t\ttolerateSideEffects: true`;
  const after = `return completion.outcome === "silent" && !shouldSkipNonVisibleTurnRetry({
\t\t...params,
\t\t// A handled read error does not invalidate an explicit, completed NO_REPLY.
\t\t// Preserve all cancellation, unfinished-tool, approval and delivery checks.
\t\tattempt: assistant.silent && assistant.assistant?.stopReason === "stop"
\t\t\t? { ...params.attempt, lastToolError: void 0 }
\t\t\t: params.attempt,
\t\ttolerateSideEffects: true`;
  if (source.split(before).length !== 2)
    throw Error(
      "Unexpected silent-turn implementation; review before patching",
    );
  return MARKER + "\n" + source.replace(before, after);
}
export function applySilentTurnPatch(root) {
  return installReviewedPatch(root, {
    pattern: /^builtin-openclaw-[\w-]+\.mjs$/,
    contains: "function shouldTreatEmptyAssistantReplyAsSilent(params)",
    patch: patchSilentTurn,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ patched: applySilentTurnPatch(process.argv[2]) }),
  );
