import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, secret, type Config } from "./config.ts";
import { start } from "./runtime.ts";
import { buildSources } from "./bootstrap.ts";
import { Store } from "./store.ts";
import { openDatabase } from "./database.ts";
import { Telegram } from "./adapters/telegram.ts";
import { authorizeGoogle } from "./oauth.ts";
import { verifyPlanner } from "./model.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
async function main(): Promise<void> {
  process.umask(0o077);
  const envPath = option("--env-file");
  if (envPath) process.loadEnvFile(resolve(envPath));
  const command = process.argv[2] ?? "help";
  if (command === "help") {
    console.log(
      "Commands: start, doctor, auth-google. Options: --config PATH --env-file PATH. Doctor: --online. OAuth: --account ID --output PATH.",
    );
    return;
  }
  const path =
    option("--config") ?? process.env.ASSISTANT_CONFIG ?? "config.json";
  if (!existsSync(path))
    throw new Error(
      "Config missing. Copy config.example.json to an external config directory; see README.md.",
    );
  const config = loadConfig(path);
  if (command === "start") return start(config);
  if (command === "doctor") return doctor(config);
  if (command === "auth-google") {
    return enroll(config);
  }
  throw new Error("Unknown command. Use help.");
}
async function enroll(config: Config): Promise<void> {
  const account = option("--account");
  const output = option("--output");
  if (!account || !output)
    throw new Error("auth-google requires --account ID and --output PATH");
  return authorizeGoogle(config, account, resolve(output));
}
async function doctor(config: Config): Promise<void> {
  const variables = [config.telegram.tokenEnv];
  if (config.modelProvider === "openai") variables.push(config.openaiKeyEnv);
  if (config.gmail)
    variables.push(
      config.gmail.clientIdEnv,
      config.gmail.clientSecretEnv,
      ...config.gmail.accounts.map((account) => account.refreshTokenEnv),
    );
  if (config.whatsapp?.tokenEnv) variables.push(config.whatsapp.tokenEnv);
  const missing = variables.filter((name) => !process.env[name]);
  console.log(
    JSON.stringify({
      config: "valid",
      mode: config.mode,
      modelProvider: config.modelProvider,
      missingEnvironment: missing,
      dataDir: config.dataDir,
    }),
  );
  if (missing.length) {
    process.exitCode = 1;
    return;
  }
  if (!process.argv.includes("--online")) return;
  const store = new Store(openDatabase(":memory:"));
  const sources = buildSources(config, store);
  try {
    await verifyPlanner(config);
    if (config.modelProvider === "claude-cli")
      console.log("Claude Code subscription login verified");
    for (const source of sources.values()) {
      await source.verify();
      console.log(`${source.id}: identity verified`);
    }
    const telegram = new Telegram({
      token: secret(config.telegram.tokenEnv),
      chatId: config.telegram.chatId,
    });
    await telegram.verify();
    console.log(
      "Telegram bot and private chat verified. No messages sent; no source cursors advanced. Model access is not exercised by doctor.",
    );
  } finally {
    for (const source of sources.values()) source.close?.();
    store.db.close();
  }
}
main().catch((error: unknown) => {
  // Configuration errors are local; provider payloads and credentials are never dumped.
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`Assistant stopped: ${message.slice(0, 500)}`);
  process.exitCode = 1;
});
