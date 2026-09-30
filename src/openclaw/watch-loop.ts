import { setTimeout as sleep } from "node:timers/promises";
import type { Scan } from "./watch-gmail.ts";
import type { Checkpoint, IncomingEvent, WatchStore } from "./watch-store.ts";
export interface Detector {
  source: string;
  scan(checkpoint?: Checkpoint): Promise<Scan>;
}
type Log = (event: Record<string, unknown>) => void;
export async function pollDetector(
  detector: Detector,
  store: WatchStore,
  now?: number,
): Promise<number> {
  const scanStartedAt = now ?? Date.now();
  const result = await detector.scan(store.checkpoint(detector.source));
  return store.ingest(
    detector.source,
    result.cursor,
    result.events,
    scanStartedAt,
  );
}
export async function dispatchPending(
  store: WatchStore,
  wake: (events: IncomingEvent[]) => Promise<void>,
): Promise<number> {
  const pending = store.pending();
  if (!pending.length) return 0;
  await wake(pending);
  store.dispatched(pending, Date.now());
  return pending.length;
}
export async function repeat(
  task: () => Promise<void>,
  interval: number,
  signal: AbortSignal,
  log: Log,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await task();
      failures = 0;
    } catch {
      failures++;
      log({ event: "watch_retry", failures });
    }
    const delay = failures
      ? Math.min(60_000, interval * 2 ** Math.min(failures, 6))
      : Math.max(10, interval - (Date.now() - started));
    await sleep(delay, undefined, { signal }).catch(() => {});
  }
}
