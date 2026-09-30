import { Engine } from "./engine.ts";
import { renderOutgoing, renderReview } from "./review.ts";
import type { Outgoing } from "./store.ts";
import type { Messenger, TelegramUpdate } from "./adapters/telegram.ts";

export class TelegramController {
  constructor(
    private readonly engine: Engine,
    private readonly messenger: Messenger,
    private readonly owner: { userId: number; chatId: number },
  ) {}
  async handle(update: TelegramUpdate): Promise<void> {
    const offset = Number(this.engine.store.get("telegram:offset") ?? 0);
    if (update.update_id < offset) return;
    if (this.authorized(update)) await this.handleAuthorized(update);
    this.engine.store.set("telegram:offset", String(update.update_id + 1));
  }
  private authorized(update: TelegramUpdate): boolean {
    const actor = update.callback_query?.from ?? update.message?.from;
    const message = update.callback_query?.message ?? update.message;
    return (
      actor?.id === this.owner.userId &&
      message?.chat.id === this.owner.chatId &&
      message.chat.type === "private"
    );
  }
  private async handleAuthorized(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query;
    if (callback) {
      const result = await this.callback(callback);
      // Callback acknowledgements expire quickly and have no authority over execution.
      try {
        await this.messenger.answer(callback.id, result);
      } catch {
        /* Card receipt remains durable. */
      }
      this.engine.notice(`update:${update.update_id}`, result);
      return;
    }
    const message = update.message;
    if (!message?.text) return;
    const card =
      message.reply_to_message &&
      this.engine.store.card(message.reply_to_message.message_id);
    const result = card
      ? await this.engine.correct(card.proposal_id, card.version, message.text)
      : this.command(message.text);
    this.engine.notice(`update:${update.update_id}`, result);
  }
  private async callback(
    callback: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<string> {
    const match = /^(approve|edit|skip|later):([a-f0-9]{16}):(\d+)$/.exec(
      callback.data ?? "",
    );
    if (!match || !callback.message) return "Unknown action.";
    const action = match[1]!;
    const id = match[2]!;
    const version = Number(match[3]);
    const card = this.engine.store.card(callback.message.message_id);
    if (card?.proposal_id !== id || card.version !== version)
      return "This card is not registered. Use the latest review card.";
    if (action === "approve") return this.engine.approve(id, version);
    if (action === "edit") return this.engine.requestEdit(id, version);
    if (action === "skip" || action === "later")
      return this.engine.dismiss(id, version, action);
    return "Unknown action.";
  }
  private command(text: string): string {
    const refresh = /^\/refresh ([a-f0-9]{16})$/.exec(text);
    if (refresh) return this.engine.refresh(refresh[1]!);
    if (text === "/status") return this.status();
    if (text === "/digest") return this.digest();
    if (text === "/pending") {
      const proposals = this.engine.store.proposals(["pending", "needs_input"]);
      for (const proposal of proposals)
        this.engine.store.enqueue(
          `reshow:${proposal.id}:${this.engine.now()}`,
          { proposalId: proposal.id, version: proposal.version },
          this.engine.now(),
        );
      return `${proposals.length} pending proposals.`;
    }
    const resolution = /^\/resolve ([a-f0-9]{16}) (sent|skip)$/.exec(text);
    if (resolution)
      return this.engine.resolve(
        resolution[1]!,
        resolution[2] as "sent" | "skip",
      );
    return "Use the buttons on a proposal, or reply to its card with corrections. /status /pending /digest. Plain yes never sends. For uncertain delivery: inspect the source app, then /resolve ID sent or /resolve ID skip.";
  }
  private status(): string {
    const pending = this.engine.store.proposals([
      "pending",
      "needs_input",
      "snoozed",
    ]).length;
    const uncertain = this.engine.store.proposals(["uncertain"]).length;
    const health = [...this.engine.sources.keys()].map(
      (id) =>
        `${id}: ${this.engine.store.get(`health:${id}`) ?? "not checked"}`,
    );
    return [
      `Mode: ${this.engine.options.mode}`,
      `Pending: ${pending}. Uncertain: ${uncertain}.`,
      ...health,
    ].join("\n");
  }
  private digest(): string {
    const rows = this.engine.store.db
      .prepare(
        "SELECT key,value FROM kv WHERE key LIKE 'digest:%' ORDER BY key LIMIT 5",
      )
      .all() as { key: string; value: string }[];
    if (!rows.length) return "No new digest items.";
    // Items are retained until their Telegram outbox record exists.
    this.engine.store.db.transaction(() => {
      for (const row of rows) {
        this.engine.notice(row.key, row.value);
        this.engine.store.db.prepare("DELETE FROM kv WHERE key=?").run(row.key);
      }
    })();
    return `${rows.length} digest items queued. Use /digest again for more.`;
  }
  async deliver(): Promise<void> {
    for (const row of this.engine.store.outbox(this.engine.now())) {
      try {
        const outgoing = JSON.parse(row.payload) as Outgoing;
        const payload = this.payload(outgoing);
        if (!payload) {
          this.engine.store.delivered(row.id, 0, {});
          continue;
        }
        const messageId = await this.messenger.send({ ...payload });
        this.engine.store.delivered(row.id, messageId, outgoing);
      } catch {
        this.engine.store.retryOutbox(row, this.engine.now());
        this.engine.store.audit(
          "telegram_delivery_failed",
          String(row.id),
          "Will retry with backoff",
          this.engine.now(),
        );
      }
    }
  }
  private payload(
    outgoing: Outgoing,
  ): ReturnType<typeof renderOutgoing> | undefined {
    if (!outgoing.proposalId) return renderOutgoing(outgoing);
    const proposal = this.engine.store.proposal(outgoing.proposalId);
    if (
      !proposal ||
      proposal.version !== outgoing.version ||
      !["pending", "needs_input"].includes(proposal.state)
    )
      return undefined;
    return outgoing.text
      ? renderOutgoing(outgoing)
      : renderReview(proposal, this.engine.options.mode);
  }
}
