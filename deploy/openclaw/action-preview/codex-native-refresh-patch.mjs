import { pathToFileURL } from "node:url";
import { installReviewedPatch } from "./reviewed-runtime-patch.mjs";
const marker = "// secretary: native Codex owns imported OAuth renewal";
export function patchCodexNativeRefresh(source, moduleUrl, clientUrl, command) {
  if (source.startsWith(marker)) return source;
  const before = "async function refreshOpenAICodexOAuthCredential(cred) {";
  if (source.split(before).length !== 2)
    throw Error(
      "Unexpected OpenAI refresh implementation; review before patching",
    );
  const after =
    before +
    `
  if (cred.displayName === "Codex import") {
    return await refreshImportedCodexLogin(cred, { refresh: async () => {
      const { t: Client } = await import(${JSON.stringify(clientUrl)});
      const signal = AbortSignal.timeout(30000);
      const client = await Client.start({
        transport: "stdio", command: ${JSON.stringify(command)},
        commandSource: "resolved-managed", args: ["app-server"], homeScope: "user",
        clearEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
      }, () => signal.throwIfAborted());
      const abort = () => client.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        await client.initialize();
        await client.request("account/read", { refreshToken: true }, { signal });
      } finally {
        signal.removeEventListener("abort", abort);
        const stopped = await client.closeAndWait({ forceKillDelayMs: 1000, exitTimeoutMs: 2000 });
        if (!stopped.exited) throw Error("Native Codex auth reader did not stop");
      }
    } });
  }`;
  return (
    marker +
    "\nimport { refreshImportedCodexLogin } from " +
    JSON.stringify(moduleUrl) +
    ";\n" +
    source.replace(before, after)
  );
}
export function applyCodexNativeRefreshPatch(root, clientUrl, command) {
  return installReviewedPatch(root, {
    pattern: /^openai-chatgpt-provider-[\w-]+\.mjs$/,
    contains: "async function refreshOpenAICodexOAuthCredential(cred)",
    patch: (source) =>
      patchCodexNativeRefresh(
        source,
        new URL("./codex-native-refresh.mjs", import.meta.url).href,
        clientUrl,
        command,
      ),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({
      patched: applyCodexNativeRefreshPatch(...process.argv.slice(2)),
    }),
  );
