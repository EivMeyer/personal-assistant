// The review queue posts every staged item to Telegram on its own. A background
// reply that restates the item arrives as a second copy, so the run gets one
// chance to drop it before the reply is delivered.
const HEARTBEAT = /:heartbeat$/;
const QUIET = /^\s*(?:HEARTBEAT_OK|NO_REPLY)\s*$/;
// Longer than the four-minute background budget, short enough to expire stale marks.
const WINDOW = 6 * 60_000;

export class QueueEchoGuard {
  constructor(now = Date.now) {
    this.now = now;
    this.marks = new Map();
  }
  staged(ctx) {
    if (!HEARTBEAT.test(ctx?.sessionKey ?? "")) return;
    const at = this.now();
    for (const [key, time] of this.marks)
      if (at - time >= WINDOW) this.marks.delete(key);
    for (const key of [ctx.sessionId, ctx.sessionKey])
      if (key) this.marks.set(key, at);
  }
  check(event, ctx) {
    const sessionKey = event?.sessionKey ?? ctx?.sessionKey ?? "";
    if (!HEARTBEAT.test(sessionKey)) return;
    const keys = [event?.sessionId ?? ctx?.sessionId, sessionKey].filter(
      Boolean,
    );
    const staged = keys.some(
      (key) => this.marks.has(key) && this.now() - this.marks.get(key) < WINDOW,
    );
    for (const key of keys) this.marks.delete(key);
    const reply = event?.lastAssistantMessage;
    if (!staged || typeof reply !== "string" || QUIET.test(reply)) return;
    return {
      action: "revise",
      reason:
        "The review queue already posted this run's staged items to Telegram.",
      retry: {
        idempotencyKey: "secretary-no-queue-echo",
        maxAttempts: 1,
        instruction:
          "Your final reply goes to the owner's Telegram chat, and the review queue already posted every item you staged in this run there as its own message. Do not call tools. Rewrite the reply without repeating or summarizing those items: keep only a notice that no staged item covers, or reply HEARTBEAT_OK.",
      },
    };
  }
}
