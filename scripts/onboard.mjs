import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { existsSync, statSync } from "node:fs";
import { STEPS } from "./onboard-config.mjs";
import {
  readJson,
  prepareInstallation,
  applyInstallation,
} from "./onboard-files.mjs";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2),
  mode = args[0]?.startsWith("-") ? "prepare" : (args[0] ?? "prepare");
function option(name, fallback) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
}
const home = resolve(option("--home", homedir()));
async function askProfile() {
  if (!process.stdin.isTTY)
    throw Error(
      "Use --profile /private/path/owner.json for agentic/noninteractive setup.",
    );
  const ui = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return {
      name: (await ui.question("Your name: ")).trim(),
      workEmail: (await ui.question("Your @theopenengine.com email: ")).trim(),
      telegramUserId: (
        await ui.question("Your numeric Telegram user ID: ")
      ).trim(),
      timezone:
        (await ui.question("Timezone [Europe/Oslo]: ")).trim() || "Europe/Oslo",
    };
  } finally {
    ui.close();
  }
}
async function doctor() {
  const profile = join(home, ".local/share/secretary/profile.json");
  const config = join(home, ".openclaw/openclaw.json");
  const token = join(home, ".openclaw/telegram-token");
  const checks = {
    profile: existsSync(profile),
    config: existsSync(config),
    telegramToken: existsSync(token),
  };
  const owner = checks.profile ? await readJson(profile) : null;
  const runtime = checks.config ? await readJson(config) : {};
  checks.privateProfile =
    checks.profile && (statSync(profile).mode & 0o077) === 0;
  checks.ownerBound = Boolean(
    owner &&
    runtime.channels?.telegram?.allowFrom?.length === 1 &&
    String(runtime.channels.telegram.allowFrom[0]) === owner.telegramUserId,
  );
  checks.actionPermissions = Object.entries(runtime.mcp?.servers ?? {})
    .filter(([name]) => name.endsWith("-actions"))
    .every(
      ([, s]) =>
        s.codex?.defaultToolsApprovalMode === "prompt" &&
        s.args?.some((a) => a.endsWith("/guarded-mcp.mjs")),
    );
  return {
    checks,
    readyForHealthCheck: Object.values(checks).every(Boolean),
    connectedSources: Object.keys(runtime.mcp?.servers ?? {}),
    next: "Run openclaw health --json; then verify each source identity. Configured is not tested.",
  };
}
try {
  let result;
  if (mode === "plan") result = { schemaVersion: 1, steps: STEPS };
  else if (mode === "doctor") result = await doctor();
  else if (mode === "apply") result = await applyInstallation(home, repo);
  else if (mode === "prepare")
    result = await prepareInstallation(
      option("--profile")
        ? await readJson(resolve(option("--profile")))
        : await askProfile(),
      home,
      repo,
    );
  else throw Error("Use prepare, plan, doctor or apply");
  console.log(JSON.stringify(result, null, 2));
  if (result.readyForHealthCheck === false) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
