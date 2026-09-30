import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareInstallation, applyInstallation } from "./onboard-files.mjs";
import { installationConfig } from "./onboard-config.mjs";
import { profileSchema } from "../deploy/openclaw/action-preview/owner-profile.mjs";
const repo = resolve(import.meta.dirname, "..");
const owner = {
  name: "Another Owner",
  workEmail: "another@theopenengine.com",
  telegramUserId: "800000002",
  timezone: "Europe/Berlin",
};
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "secretary-onboard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("fresh setup is private, repeatable and uses the new owner's identity", async (t) => {
  const dir = await home(t);
  const result = await prepareInstallation(owner, dir, repo);
  assert.equal(result.activated, false);
  assert.deepEqual(await prepareInstallation(owner, dir, repo), result);
  assert.equal((await stat(result.profile)).mode & 0o077, 0);
  const config = JSON.parse(await readFile(result.overlay, "utf8"));
  assert.deepEqual(config.channels.telegram.allowFrom, [owner.telegramUserId]);
  assert.equal(config.agents.defaults.userTimezone, owner.timezone);
  const text = await readFile(
    join(dir, ".local/share/secretary/setup/workspace/AGENTS.md"),
    "utf8",
  );
  assert.ok(text.includes(owner.workEmail));
  assert.ok(!text.includes("{{workEmail}}"));
  await assert.rejects(
    prepareInstallation({ ...owner, telegramUserId: "900000003" }, dir, repo),
    /left unchanged/,
  );
  assert.equal(
    JSON.parse(await readFile(result.profile, "utf8")).telegramUserId,
    owner.telegramUserId,
  );
});
test("activation preserves auth, binds one owner and refuses another owner's installation", async (t) => {
  const dir = await home(t);
  await prepareInstallation(owner, dir, repo);
  await mkdir(join(dir, ".openclaw"), { recursive: true });
  const path = join(dir, ".openclaw/openclaw.json");
  const base = {
    gateway: { auth: { mode: "token", token: "fixture-token" } },
    channels: { telegram: { allowFrom: [owner.telegramUserId] } },
  };
  await writeFile(path, JSON.stringify(base));
  await writeFile(join(dir, ".openclaw/telegram-token"), "fixture-bot-token", {
    mode: 0o600,
  });
  await applyInstallation(dir, repo);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.gateway.auth.token, "fixture-token");
  assert.equal(config.gateway.bind, "loopback");
  assert.ok(config.tools.deny.includes("exec"));
  assert.ok(config.tools.fs.workspaceOnly);
  config.channels.telegram.allowFrom = ["900000003"];
  await writeFile(path, JSON.stringify(config));
  await assert.rejects(applyInstallation(dir, repo), /owner differs/);
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).channels.telegram.allowFrom[0],
    "900000003",
  );
});
test("invalid identities and partial Slack binding fail before activation", () => {
  for (const change of [
    { workEmail: "personal@example.com" },
    { telegramUserId: "-10012345" },
    { timezone: "invalid" },
    { slackUserId: "UOTHER" },
  ])
    assert.equal(
      profileSchema.safeParse({ ...owner, ...change }).success,
      false,
    );
  const cfg = installationConfig(
    { ...owner, slackUserId: "UOTHER", slackTeamId: "TOTHER" },
    "/tmp/test-home",
    repo,
  );
  assert.equal(
    cfg.channels.telegram.execApprovals.approvers[0],
    owner.telegramUserId,
  );
  assert.equal(cfg.agents.defaults.model.fallbacks.length, 0);
});
