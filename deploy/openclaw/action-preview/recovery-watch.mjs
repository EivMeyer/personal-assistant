import {
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export function shouldRecover({
  lines,
  now,
  lastRestart = 0,
  activeActions = 0,
}) {
  if (activeActions || now - lastRestart < 300_000) return false;
  return (
    lines.filter((line) => {
      const at = Date.parse(line.slice(0, 29));
      return (
        at <= now &&
        now - at < 120_000 &&
        /Session binding owner changed|Conversation binding owner changed/.test(
          line,
        )
      );
    }).length >= 2
  );
}
function tail(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const size = fstatSync(fd).size;
    const count = readSync(
      fd,
      buffer,
      0,
      buffer.length,
      Math.max(0, size - buffer.length),
    );
    return buffer.subarray(0, count).toString("utf8").split("\n");
  } finally {
    closeSync(fd);
  }
}
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
export function recoverGateway({ lines, now, state, active, restart, save }) {
  if (
    !shouldRecover({
      lines,
      now,
      lastRestart: state.lastRestart,
      activeActions: active,
    })
  )
    return false;
  save({ lastRestart: now });
  restart();
  return true;
}
function main() {
  const home = homedir();
  const statePath = join(home, ".local/share/secretary-watch/recovery.json");
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const recovered = recoverGateway({
    lines: tail(join(home, "Library/Logs/openclaw/gateway.log")),
    now: Date.now(),
    state,
    active: activeActions(
      join(home, ".local/share/secretary-actions/actions.sqlite"),
    ),
    save: (next) =>
      writeFileSync(statePath, JSON.stringify(next), { mode: 0o600 }),
    restart: () =>
      execFileSync(
        join(home, ".local/bin/openclaw"),
        ["gateway", "restart", "--safe"],
        { timeout: 30000 },
      ),
  });
  if (recovered)
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        event: "gateway_binding_recovered",
      }),
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
