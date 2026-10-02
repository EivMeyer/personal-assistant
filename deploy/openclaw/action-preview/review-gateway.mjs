import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
const execute = promisify(execFile);
const allowed = new Set(["chat.send"]);
export async function reviewGateway(method, params = {}) {
  if (!allowed.has(method)) throw Error("Unsupported review operation.");
  const { stdout } = await execute(
    join(homedir(), ".local/bin/openclaw"),
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      "15000",
    ],
    { timeout: 20000, maxBuffer: 2000000 },
  );
  return JSON.parse(stdout);
}
