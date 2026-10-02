import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

function activeActions(path) {
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT count(*) AS count FROM actions WHERE state IN ('pending','checking','executing')",
      )
      .get().count;
  } finally {
    db.close();
  }
}
function healthyTelegram(health, now) {
  const telegram = health?.channels?.telegram;
  const activity =
    telegram?.lastTransportActivityAt ?? telegram?.lastConnectedAt;
  return (
    health?.ok === true &&
    telegram?.running === true &&
    telegram?.connected === true &&
    telegram?.lifecycle === "ready" &&
    typeof activity === "number" &&
    now - activity < 90_000
  );
}
export function recoveryDecision({ health, now, state, active, networkReady }) {
  if (healthyTelegram(health, now))
    return {
      action: "healthy",
      state: { lastRestart: state.lastRestart ?? 0 },
    };
  // Sleep and network outages cannot be repaired by restarting the gateway.
  if (!networkReady)
    return { action: "offline", state: { ...state, unhealthySince: null } };
  const unhealthySince = state.unhealthySince ?? now;
  const next = { ...state, unhealthySince };
  if (
    active ||
    now - unhealthySince < 120_000 ||
    now - (state.lastRestart ?? 0) < 300_000
  )
    return { action: "wait", state: next };
  return {
    action: "restart",
    state: { lastRestart: now, unhealthySince: null },
  };
}
async function main() {
  const home = homedir();
  const statePath = join(home, ".local/share/secretary-watch/recovery.json");
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const run = promisify(execFile);
  const cli = join(home, ".local/bin/openclaw");
  let health;
  try {
    health = JSON.parse(
      (await run(cli, ["health", "--json"], { timeout: 10000 })).stdout,
    );
  } catch {
    /* A failed live probe is evidence, not a reason for an immediate restart. */
  }
  let networkReady = false;
  try {
    const response = await fetch("https://api.telegram.org", {
      signal: AbortSignal.timeout(5000),
    });
    networkReady = response.ok;
  } catch {
    /* Retain queued work until connectivity returns. */
  }
  const decision = recoveryDecision({
    health,
    now: Date.now(),
    state,
    networkReady,
    active: activeActions(
      join(home, ".local/share/secretary-actions/actions.sqlite"),
    ),
  });
  writeFileSync(statePath, JSON.stringify(decision.state), { mode: 0o600 });
  if (
    decision.action === "healthy" &&
    state.lastRestart &&
    state.unhealthySince !== undefined
  )
    logRecovery("gateway_health_confirmed");
  if (decision.action !== "restart") return;
  logRecovery("gateway_restart_requested");
  try {
    await run(cli, ["gateway", "restart", "--safe"], { timeout: 120000 });
    // The next health probe, not the restart command's exit, proves recovery.
  } catch (error) {
    logRecovery("gateway_restart_unconfirmed", {
      code: String(error.code ?? "timeout"),
    });
  }
}
function logRecovery(event, details = {}) {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...details }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
