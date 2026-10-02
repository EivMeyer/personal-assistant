import { digest } from "./action-store.mjs";
import { ReviewStore, validateProposal } from "./review-store.mjs";
import { snapshotSources } from "./source-snapshot.mjs";
import { reviewGateway } from "./review-gateway.mjs";
export class ReviewService {
  constructor({
    actions,
    config,
    rpc = reviewGateway,
    snapshot = snapshotSources,
  }) {
    this.actions = actions;
    this.store = new ReviewStore(actions);
    this.config = config;
    this.rpc = rpc;
    this.snapshot = snapshot;
  }
  async propose(params) {
    if (!params.action) return this.store.stage(params);
    validateProposal(params.action);
    const snapshot = await this.snapshot(
      params.action.server,
      params.action.args,
      this.config,
    );
    return this.store.stage({ ...params, snapshot });
  }
  async open(id, version) {
    const item = this.store.get(id);
    if (item.version !== version || item.state !== "ready")
      throw Error("This item is no longer ready for review.");
    const current = await this.snapshot(
      item.action.server,
      item.action.args,
      this.config,
    );
    if (digest(current) !== digest(item.snapshot)) {
      this.store.change(id, version, {
        state: "needs_info",
        error:
          "The source conversation changed. Ask the assistant to prepare an updated action.",
      });
      throw Error("The source conversation changed. Nothing was sent.");
    }
    this.ensureAvailable();
    const sessionKey = `agent:main:secretary-review:${id}:${version}`;
    const opening = this.store.change(id, version, {
      state: "opening",
      sessionKey,
      error: "",
    });
    try {
      await this.rpc("chat.send", {
        sessionKey,
        idempotencyKey: `review-${id}-${version}`,
        message: `The verified owner opened action ${id} for review in Telegram. Use secretary_review load for this session. Invoke exactly the stored action tuple, including all arguments, to present its native approval. Do not modify or repeat it. Opening is not approval. Wait for the native approval and terminal result.`,
        deliver: false,
      });
    } catch (e) {
      this.store.change(id, opening.version, {
        state: "needs_info",
        error:
          "Could not confirm review preparation. Check the current action before retrying.",
      });
      throw e;
    }
    return this.store.get(id);
  }
  ensureAvailable() {
    const pending = this.actions.db
      .prepare(
        "SELECT id FROM actions WHERE state IN ('checking','executing') OR (state='pending' AND expires>?)",
      )
      .get(Date.now());
    const opening = this.actions.db
      .prepare(
        "SELECT id FROM review_items WHERE state='opening' AND updated>?",
      )
      .get(Date.now() - 300000);
    if (pending || opening)
      throw Error("Finish the current action review before opening another.");
  }
  reject(id, version) {
    const row = this.store.get(id);
    if (!["ready", "needs_info"].includes(row.state))
      throw Error("Resolve the pending native approval first.");
    return this.store.change(id, version, { state: "rejected" });
  }
  async answer(id, version, answer) {
    if (typeof answer !== "string" || !answer.trim() || answer.length > 24000)
      throw Error("An answer is required.");
    const row = this.store.get(id);
    if (row.state !== "needs_info")
      throw Error("This question is no longer pending.");
    const changed = this.store.change(id, version, {
      state: "answered",
      answer,
    });
    try {
      await this.rpc("chat.send", {
        sessionKey: "agent:main:secretary-input:" + id,
        idempotencyKey: `answer-${id}-${version}`,
        message: `Owner answer to review item ${id}. Question: ${row.question || row.error}\nAnswer: ${answer}\nRead current sources and use secretary_review to prepare an exact action or ask a specific question. Do not send anything without native approval.`,
        deliver: false,
      });
    } catch (e) {
      this.store.change(id, changed.version, {
        state: "needs_info",
        error: "Answer delivery is unconfirmed. Check before submitting again.",
      });
      throw e;
    }
    return this.store.get(id);
  }
}
