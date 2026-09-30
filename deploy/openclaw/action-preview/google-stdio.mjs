import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
export async function serveGoogle({ name, tools, call }, settingsPath) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  async function handle(message) {
    if (message.method === "initialize")
      return {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name, version: "1.0.0" },
      };
    if (message.method === "ping") return {};
    if (message.method === "tools/list") return { tools };
    if (message.method !== "tools/call") throw Error("Unsupported method");
    return call(message.params.name, message.params.arguments ?? {}, settings);
  }
  for await (const line of createInterface({ input: process.stdin })) {
    let message;
    try {
      if (line.length > 1024 * 1024) throw Error("Request too large");
      message = JSON.parse(line);
      if (message.id === undefined) continue;
      send({ jsonrpc: "2.0", id: message.id, result: await handle(message) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32603, message: error.message },
      });
    }
  }
}
