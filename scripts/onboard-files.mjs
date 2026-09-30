import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { WatchStore } from "../src/openclaw/watch-store.ts";
import { profileSchema } from "../deploy/openclaw/action-preview/owner-profile.mjs";
import { installationConfig, mergeConfig } from "./onboard-config.mjs";
export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
async function writeOnce(path, text) {
  if (await exists(path)) {
    if ((await readFile(path, "utf8")) !== text)
      throw Error("Existing file differs; left unchanged: " + path);
    return;
  }
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
}
export async function prepareInstallation(input, home, repo) {
  const owner = profileSchema.parse(input);
  const root = join(home, ".local/share/secretary");
  await writeOnce(
    join(root, "profile.json"),
    JSON.stringify(owner, null, 2) + "\n",
  );
  for (const folder of [
    "secretary-watch",
    "secretary-context",
    "secretary-actions",
  ])
    await mkdir(join(home, ".local/share", folder), {
      recursive: true,
      mode: 0o700,
    });
  const store = new WatchStore(
    join(home, ".local/share/secretary-watch/watch.sqlite"),
  );
  store.db.close();
  const overlay = installationConfig(owner, home, repo);
  await writeOnce(
    join(root, "setup/openclaw-overlay.json"),
    JSON.stringify(overlay, null, 2) + "\n",
  );
  for (const name of await readdir(join(repo, "deploy/openclaw/workspace"))) {
    const text = (
      await readFile(join(repo, "deploy/openclaw/workspace", name), "utf8")
    )
      .replaceAll("{{workEmail}}", owner.workEmail)
      .replaceAll("{{slackUserId}}", owner.slackUserId ?? "not connected");
    await writeOnce(join(root, "setup/workspace", name), text);
  }
  await writeOnce(
    join(root, "setup/workspace/USER.md"),
    `# Owner\n\nName: ${owner.name}\nCompany email: ${owner.workEmail}\nTimezone: ${owner.timezone}\n`,
  );
  return {
    profile: join(root, "profile.json"),
    overlay: join(root, "setup/openclaw-overlay.json"),
    activated: false,
  };
}
function assertSafeMerge(base, overlay) {
  const allowed = base.channels?.telegram?.allowFrom ?? [];
  if (allowed.some((id) => String(id) !== overlay.channels.telegram.defaultTo))
    throw Error("Existing Telegram owner differs. Do not mix installations.");
  if (Object.keys(base.mcp?.servers ?? {}).length)
    throw Error(
      "Existing connectors require an agent-reviewed merge; automatic apply is for a fresh installation.",
    );
}
export async function applyInstallation(home, repo) {
  const root = join(home, ".local/share/secretary");
  const owner = await readJson(join(root, "profile.json"));
  const overlay = installationConfig(owner, home, repo);
  const path = join(home, ".openclaw/openclaw.json");
  const base = await readJson(path);
  assertSafeMerge(base, overlay);
  const token = join(home, ".openclaw/telegram-token");
  if (!(await exists(token)))
    throw Error(
      "Save your own Telegram bot token in ~/.openclaw/telegram-token with chmod 600 first.",
    );
  // Refuse conflicting workspace files before touching the live configuration.
  const staged = join(root, "setup/workspace"),
    workspace = overlay.agents.defaults.workspace;
  const names = await readdir(staged);
  for (const name of names) {
    const target = join(workspace, name);
    if (
      (await exists(target)) &&
      (await readFile(target, "utf8")) !==
        (await readFile(join(staged, name), "utf8"))
    )
      throw Error(
        "Existing workspace needs an agent-reviewed merge: " + target,
      );
  }
  const backup = path + ".before-secretary-" + Date.now();
  await copyFile(path, backup);
  for (const name of names)
    await writeOnce(
      join(workspace, name),
      await readFile(join(staged, name), "utf8"),
    );
  const merged = mergeConfig(base, overlay);
  merged.plugins.load.paths = [
    ...new Set([
      ...(base.plugins?.load?.paths ?? []),
      ...overlay.plugins.load.paths,
    ]),
  ];
  // Keep model credentials from the official wizard; replace unsafe tool/channel defaults.
  delete merged.channels.telegram.botToken;
  await writeFile(path, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  return { config: path, backup, restartRequired: true };
}
