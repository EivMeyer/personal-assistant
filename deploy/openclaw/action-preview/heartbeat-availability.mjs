// A suspended laptop cannot finish a background check or deliver its result.
// Keep queue ownership with the existing runtime; only defer/abort the read-only run.
export function createHeartbeatAvailability({
  now = Date.now,
  probe = telegramReachable,
} = {}) {
  let lastTick = now();
  let readyAt = lastTick + 30_000;
  const leases = new Set();
  function tick() {
    const time = now();
    if (time - lastTick > 15_000 || time < lastTick) {
      readyAt = time + 30_000;
      for (const lease of leases)
        lease.abort(
          new Error("Background check deferred after host suspension"),
        );
    }
    lastTick = time;
  }
  return {
    tick,
    async ready() {
      tick();
      if (now() < readyAt) return false;
      const online = await probe().catch(() => false);
      tick();
      return online && now() >= readyAt;
    },
    lease(parent) {
      tick();
      const controller = new AbortController();
      leases.add(controller);
      return {
        signal: parent
          ? AbortSignal.any([parent, controller.signal])
          : controller.signal,
        suspended() {
          tick();
          return controller.signal.aborted;
        },
        dispose() {
          leases.delete(controller);
        },
      };
    },
  };
}
async function telegramReachable() {
  const response = await fetch("https://api.telegram.org", {
    method: "HEAD",
    signal: AbortSignal.timeout(3000),
  });
  return response.ok;
}
export const heartbeatAvailability = createHeartbeatAvailability();
const timer = setInterval(() => heartbeatAvailability.tick(), 1000);
timer.unref();
