import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { actionKey, actionDatabase } from "./action-store.mjs";
export const reviewServers = [
  "gmail-work-actions",
  "google-work-actions",
  "slack-actions",
  "whatsapp-actions",
];
export function validateProposal(action) {
  if (
    !action ||
    !reviewServers.includes(action.server) ||
    !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(action.tool)
  )
    throw Error("Unsupported action.");
  if (
    !action.args ||
    Array.isArray(action.args) ||
    typeof action.args !== "object"
  )
    throw Error("Exact action arguments required.");
  if (JSON.stringify(action).length > 24000)
    throw Error("Action exceeds the review limit.");
  return actionKey(action.server, action.tool, action.args);
}
function text(value, max = 24000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error("Missing or oversized review text.");
  return value;
}
export class ReviewStore {
  constructor(actions) {
    this.actions = actions;
    this.db = actions.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS review_items (
      id TEXT PRIMARY KEY, sourceKey TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '', action TEXT, snapshot TEXT,
      state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      sessionKey TEXT, fingerprint TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      answer TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', actionId TEXT
    );`);
  }
  get(id) {
    const row = this.db
      .prepare("SELECT * FROM review_items WHERE id=?")
      .get(id);
    if (!row) throw Error("Review item not found.");
    return this.parse(row);
  }
  parse(row) {
    return {
      ...row,
      action: row.action ? JSON.parse(row.action) : null,
      snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
    };
  }
  list() {
    return this.db
      .prepare("SELECT * FROM review_items ORDER BY updated DESC LIMIT 500")
      .all()
      .map((r) => this.parse(r));
  }
  stage({ key, title, question, action, snapshot }) {
    text(key, 180);
    text(title, 240);
    const prior = this.db
      .prepare("SELECT * FROM review_items WHERE sourceKey=?")
      .get(key);
    if (prior) return this.restage(prior, { question, action, snapshot });
    const fingerprint = action ? validateProposal(action) : null;
    if (!action) text(question);
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO review_items(id,sourceKey,title,question,action,snapshot,state,fingerprint,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        key,
        title,
        question ?? "",
        action ? JSON.stringify(action) : null,
        snapshot ? JSON.stringify(snapshot) : null,
        action ? "ready" : "needs_info",
        fingerprint,
        now,
        now,
      );
    return this.get(id);
  }
  restage(prior, { question, action, snapshot }) {
    if (prior.state !== "answered") return this.parse(prior);
    if (!action) text(question);
    return this.change(prior.id, prior.version, {
      question: question ?? "",
      action: action ?? null,
      snapshot: snapshot ?? null,
      fingerprint: action ? validateProposal(action) : null,
      state: action ? "ready" : "needs_info",
      error: "",
    });
  }
  change(id, version, fields) {
    const allowed = [
      "state",
      "sessionKey",
      "error",
      "action",
      "snapshot",
      "fingerprint",
      "question",
      "answer",
      "actionId",
    ];
    if (!Number.isInteger(version)) throw Error("Current version required.");
    const entries = Object.entries(fields);
    if (!entries.length || entries.some(([k]) => !allowed.includes(k)))
      throw Error("Invalid review update.");
    const values = entries.map(([k, v]) =>
      ["action", "snapshot"].includes(k) ? JSON.stringify(v) : v,
    );
    const result = this.db
      .prepare(
        `UPDATE review_items SET ${entries.map(([k]) => k + "=?").join(",")},version=version+1,updated=? WHERE id=? AND version=?`,
      )
      .run(...values, Date.now(), id, version);
    if (result.changes !== 1)
      throw Error("This review changed. Refresh before deciding.");
    return this.get(id);
  }
  activeForSession(sessionKey) {
    const row = this.db
      .prepare(
        "SELECT * FROM review_items WHERE sessionKey=? AND state='opening'",
      )
      .get(sessionKey);
    return row ? this.parse(row) : null;
  }
  reconcile() {
    for (const item of this.list().filter(
      (r) => r.action && r.state === "opening",
    ))
      this.reconcileItem(item);
  }
  reconcileItem(item) {
    const action = this.db
      .prepare(
        "SELECT * FROM actions WHERE fingerprint=? AND expires>=? ORDER BY expires DESC LIMIT 1",
      )
      .get(item.fingerprint, item.updated);
    if (action) {
      const state = ["pending", "checking", "executing"].includes(action.state)
        ? "opening"
        : action.state;
      if (state !== item.state || item.actionId !== action.id)
        this.change(item.id, item.version, { state, actionId: action.id });
    } else if (Date.now() - item.updated > 300000)
      this.change(item.id, item.version, {
        state: "needs_info",
        error:
          "Preparation did not reach an approval. Ask the assistant to review this item again.",
      });
  }
}
export function authorizedWebReview(event, ctx, path = actionDatabase()) {
  if (
    ctx.requester?.channel !== "webchat" ||
    ctx.requester?.senderIsOwner !== true ||
    !ctx.sessionKey?.startsWith("agent:main:secretary-review:")
  )
    return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT fingerprint FROM review_items WHERE sessionKey=? AND state='opening'",
      )
      .get(ctx.sessionKey);
    const name = event.toolName.replace(/^mcp__/, "");
    const split = name.indexOf("__");
    return Boolean(
      row &&
      row.fingerprint ===
        actionKey(name.slice(0, split), name.slice(split + 2), event.params),
    );
  } catch {
    return false;
  } finally {
    db.close();
  }
}
