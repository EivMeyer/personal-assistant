import { ownerProfile } from "./owner-profile.mjs";
import { randomUUID } from "node:crypto";
import { digest } from "./action-store.mjs";
import { ReviewStore, validateProposal } from "./review-store.mjs";
import { snapshotSources } from "./source-snapshot.mjs";
import { reviewGateway } from "./review-gateway.mjs";
export function matchApproval(row, approvals) {
  return approvals.find(
    (p) =>
      p.request?.runId === row.runId &&
      p.request?.mcpTool?.server === row.server &&
      p.request?.mcpTool?.tool === row.tool &&
      p.expiresAtMs > Date.now(),
  );
}
function ticket(row, approval) {
  return digest({
    id: row.id,
    fingerprint: row.fingerprint,
    approvalId: approval.id,
    expires: Math.min(row.expires, approval.expiresAtMs),
  });
}
function actionView(row, approvals) {
  const approval = matchApproval(row, approvals);
  return {
    ...row,
    args: JSON.parse(row.args),
    snapshot: undefined,
    outcome: row.outcome ? JSON.parse(row.outcome) : null,
    approvalId: approval?.id,
    reviewToken: approval ? ticket(row, approval) : null,
    canApprove: Boolean(
      row.state === "pending" &&
      row.expires > Date.now() &&
      approval?.request.allowedDecisions?.includes("allow-once"),
    ),
  };
}
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
  async list() {
    const approvals = await this.rpc("plugin.approval.list");
    if (!Array.isArray(approvals))
      throw Error("Approval service returned an invalid response.");
    this.actions.db
      .prepare(
        "UPDATE actions SET state='expired' WHERE state='pending' AND expires<?",
      )
      .run(Date.now());
    this.store.reconcile();
    const actions = this.actions.db
      .prepare(
        "SELECT * FROM actions ORDER BY COALESCE(finished,expires) DESC LIMIT 100",
      )
      .all()
      .map((r) => actionView(r, approvals));
    return {
      sender: ownerProfile().workEmail,
      items: this.store.list().map(({ snapshot: _, ...row }) => row),
      actions,
    };
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
        message: `The verified owner opened action ${id} for review in the local app. Use secretary_review load for this session. Invoke exactly the stored action tuple, including all arguments, to present its native approval. Do not modify or repeat it. Opening is not approval. Wait for the native approval and terminal result.`,
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
  async resolve({ id, approvalId, reviewToken, decision }) {
    if (!["allow-once", "deny"].includes(decision))
      throw Error("One-time approval or rejection required.");
    const rows = this.actions.db
      .prepare(
        "SELECT * FROM actions WHERE id=? AND state='pending' AND expires>?",
      )
      .all(id, Date.now());
    if (rows.length !== 1)
      throw Error("This action is no longer awaiting approval.");
    const row = rows[0],
      approval = matchApproval(row, await this.rpc("plugin.approval.list"));
    if (
      !approval ||
      approval.id !== approvalId ||
      ticket(row, approval) !== reviewToken
    )
      throw Error("The exact approval changed. Refresh before deciding.");
    if (!approval.request.allowedDecisions?.includes(decision))
      throw Error("Decision not offered by this approval.");
    const result = await this.rpc("plugin.approval.resolve", {
      id: approval.id,
      decision,
    });
    if (result?.ok !== true)
      throw Error(
        "Approval outcome is unconfirmed. Refresh; do not retry the send.",
      );
    if (decision === "deny")
      this.actions.finish(id, "rejected", {
        message: "Rejected by the owner.",
      });
    return { ok: true };
  }
  reject(id, version) {
    const row = this.store.get(id);
    if (!["ready", "needs_info"].includes(row.state))
      throw Error("Resolve the pending native approval first.");
    return this.store.change(id, version, { state: "rejected" });
  }
  async edit(id, version, action) {
    const row = this.store.get(id);
    if (!["ready", "needs_info"].includes(row.state))
      throw Error("Reject the pending approval before editing.");
    validateProposal(action);
    const snapshot = await this.snapshot(
      action.server,
      action.args,
      this.config,
    );
    return this.store.change(id, version, {
      action,
      snapshot,
      fingerprint: validateProposal(action),
      state: "ready",
      sessionKey: null,
      error: "",
    });
  }
  async revise(params) {
    validateProposal(params.action);
    await this.resolve({ ...params, decision: "deny" });
    return this.propose({
      key: "revision:" + params.id + ":" + randomUUID(),
      title: params.title || "Revised action",
      action: params.action,
    });
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
  async request(text, key) {
    if (typeof text !== "string" || !text.trim() || text.length > 24000)
      throw Error("Enter your request.");
    if (typeof key !== "string" || !/^[a-f0-9-]{36}$/.test(key))
      throw Error("Request identity required.");
    return this.rpc("chat.send", {
      sessionKey: "agent:main:secretary-input:" + key,
      idempotencyKey: key,
      message: `Owner request from the local action app:\n${text}\nRead relevant source conversations. Use secretary_review to prepare separate actions for approval or ask specific missing-information questions. This request alone is not permission to send.`,
      deliver: false,
    });
  }
}
