import { setTimeout as sleep } from "node:timers/promises";
import { Engine } from "./engine.ts";
import { Telegram } from "./adapters/telegram.ts";
import { TelegramController } from "./telegram-controller.ts";

interface LoopContext {
  engine: Engine;
  telegram: Telegram;
  controller: TelegramController;
  signal: AbortSignal;
}
export async function loop(context: LoopContext): Promise<void> {
  const due = new Map<string, number>();
  let telegramFailures = 0;
  while (!context.signal.aborted) {
    try {
      const offset = Number(context.engine.store.get("telegram:offset") ?? 0);
      for (const update of await context.telegram.updates(offset))
        await context.controller.handle(update);
      telegramFailures = 0;
    } catch {
      telegramFailures++;
      context.engine.store.audit(
        "telegram_poll_failed",
        "telegram",
        "Update cursor retained",
        Date.now(),
      );
    }
    if (context.signal.aborted) break;
    await pollSources(context.engine, due);
    await context.engine.processJobs();
    await context.controller.deliver();
    context.engine.store.set("runtime:heartbeat", String(Date.now()));
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(telegramFailures, 5));
    try {
      await sleep(delay, undefined, { signal: context.signal });
    } catch {
      break;
    }
  }
}
async function pollSources(
  engine: Engine,
  due: Map<string, number>,
): Promise<void> {
  for (const source of engine.sources.values()) {
    if ((due.get(source.id) ?? 0) > Date.now()) continue;
    const key = `poll-failures:${source.id}`;
    try {
      await source.poll();
      engine.store.set(key, "0");
      engine.store.set(`health:${source.id}`, `ok ${new Date().toISOString()}`);
      due.set(
        source.id,
        Date.now() + (source.id === "whatsapp" ? 5000 : 45_000),
      );
    } catch {
      const failures = Number(engine.store.get(key) ?? 0) + 1;
      engine.store.set(key, String(failures));
      engine.store.set(
        `health:${source.id}`,
        `failed ${new Date().toISOString()}`,
      );
      due.set(
        source.id,
        Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(failures, 6)),
      );
      engine.store.audit(
        "poll_failed",
        source.id,
        "Checkpoint retained",
        Date.now(),
      );
      if (failures === 3)
        engine.notice(
          `source-down:${source.id}:${new Date().toISOString().slice(0, 10)}`,
          `${source.id} has failed three consecutive checks. Incoming messages may be delayed. Check credentials and the bridge.`,
        );
    }
  }
}
