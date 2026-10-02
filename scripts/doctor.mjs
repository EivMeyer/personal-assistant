// Checks the local configuration only. It does not prove a live delivery.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const home = homedir();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const profile = join(home, ".local/share/secretary/profile.json");
const config = join(home, ".openclaw/openclaw.json");
const checks = {
  profile: existsSync(profile),
  config: existsSync(config),
  telegramToken: existsSync(join(home, ".openclaw/telegram-token")),
};
const owner = checks.profile ? readJson(profile) : null;
const runtime = checks.config ? readJson(config) : {};
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
const ready = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      checks,
      readyForHealthCheck: ready,
      connectedSources: Object.keys(runtime.mcp?.servers ?? {}),
      next: "Run openclaw health --json. Configured is not tested.",
    },
    null,
    2,
  ),
);
if (!ready) process.exitCode = 1;
