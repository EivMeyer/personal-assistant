import { addSources } from "./action-schema.mjs";
import { verifyIdentity } from "./index.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ActionStore, executeGuarded } from "./action-guard.mjs";
const [server, backendPath] = process.argv.slice(2);
const backend = JSON.parse(await readFile(backendPath, "utf8"));
const child = spawn(backend.command, backend.args, {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
const store = new ActionStore();
let sequence = 0;
const pending = new Map();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
function failPending() {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(Error("Connector exited"));
  }
  pending.clear();
}
child.on("error", failPending);
child.on("exit", failPending);
createInterface({ input: child.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  const item = pending.get(value.id);
  if (!item) {
    if (!Object.hasOwn(value, "id")) send(value);
    return;
  }
  pending.delete(value.id);
  clearTimeout(item.timer);
  if (value.error) item.reject(Error(value.error.message));
  else item.resolve(value.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("Connector response timed out"));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}
async function dispatch(message) {
  if (message.method === "tools/list")
    return addSources(await request(message.method, message.params));
  if (message.method === "tools/call") {
    const config = JSON.parse(
      await readFile(join(homedir(), ".openclaw/openclaw.json"), "utf8"),
    );
    return executeGuarded({
      server,
      name: message.params.name,
      args: message.params.arguments,
      config,
      store,
      verify: verifyIdentity,
      invoke: (name, args) => request("tools/call", { name, arguments: args }),
    });
  }
  return request(message.method, message.params);
}
createInterface({ input: process.stdin })
  .on("line", async (line) => {
    const message = JSON.parse(line);
    if (!Object.hasOwn(message, "id")) {
      child.stdin.write(line + "\n");
      return;
    }
    try {
      send({ jsonrpc: "2.0", id: message.id, result: await dispatch(message) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error.message },
      });
    }
  })
  .on("close", () => {
    child.kill();
    store.close();
    process.exit(0);
  });
