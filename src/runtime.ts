import { loop } from "./scheduler.ts";
import { mkdirSync } from "node:fs";
import lockfile from "proper-lockfile";
import { Engine } from "./engine.ts";
import { buildSources, buildStore } from "./bootstrap.ts";
import { secret, type Config } from "./config.ts";
import { buildPlanner, verifyPlanner } from "./model.ts";
import { Telegram } from "./adapters/telegram.ts";
import { TelegramController } from "./telegram-controller.ts";

export async function start(config: Config): Promise<void> {
  process.umask(0o077);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.dataDir, {
    stale: 60_000,
    update: 10_000,
    retries: 0,
  });
  try {
    await runLocked(config);
  } finally {
    await release();
  }
}
async function runLocked(config: Config): Promise<void> {
  const store = buildStore(config);
  const sources = buildSources(config, store);
  const telegram = new Telegram({
    token: secret(config.telegram.tokenEnv),
    chatId: config.telegram.chatId,
  });
  const planner = buildPlanner(config);
  const engine = new Engine(store, sources, planner, config);
  const controller = new TelegramController(engine, telegram, config.telegram);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await verifyPlanner(config);
    await telegram.verify();
    for (const source of sources.values()) await source.verify();
    engine.recover();
    console.log(
      JSON.stringify({
        event: "started",
        mode: config.mode,
        modelProvider: config.modelProvider,
        sources: [...sources.keys()],
      }),
    );
    await loop({ engine, telegram, controller, signal: abort.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const source of sources.values()) source.close?.();
    store.db.close();
  }
}
