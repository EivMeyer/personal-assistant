import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const taskStates = [
  "inbox",
  "queued",
  "preparing",
  "needs_info",
  "ready",
  "done",
  "archived",
];
export function splitCapture(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 24000)
    throw Error("Enter between 1 and 24,000 characters.");
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  if (lines.length > 50) throw Error("Capture up to 50 items at a time.");
  return lines;
}
function bounded(value, max) {
  if (typeof value !== "string" || value.length > max)
    throw Error("Invalid task text.");
  return value;
}
export class InboxStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, hash TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, captureId TEXT NOT NULL REFERENCES captures(id), title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', draft TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'inbox', source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL, lease INTEGER, runId TEXT);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,created);`);
  }
  list() {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created DESC,id LIMIT 1000")
      .all();
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw Error("Task not found.");
    return row;
  }
  capture(text, source, key = randomUUID()) {
    const lines = splitCapture(text);
    validateCaptureKey(source, key);
    const hash = createHash("sha256")
      .update(source + "\n" + text)
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT hash FROM captures WHERE id=?")
        .get(key);
      if (prior && prior.hash !== hash)
        throw Error("This capture key already belongs to a different note.");
      if (!prior) {
        const now = Date.now();
        this.db
          .prepare("INSERT INTO captures VALUES(?,?,?,?,?)")
          .run(key, hash, source, text, now);
        const insert = this.db.prepare(
          "INSERT INTO tasks(id,captureId,title,notes,source,created,updated) VALUES(?,?,?,?,?,?,?)",
        );
        for (const line of lines)
          insert.run(
            randomUUID(),
            key,
            line.slice(0, 240),
            line.length > 240 ? line : "",
            source,
            now,
            now,
          );
      }
      const result = this.db
        .prepare("SELECT * FROM tasks WHERE captureId=? ORDER BY rowid")
        .all(key);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  update(id, version, patch, actor = "owner", runId) {
    const old = this.get(id);
    const next = validatePatch(old, version, patch);
    if (actor === "assistant") validateDraft(old, next, runId);
    else invalidateChangedDraft(old, next, patch);
    const result = this.db
      .prepare(
        "UPDATE tasks SET title=?,notes=?,draft=?,status=?,version=version+1,updated=?,lease=NULL,runId=NULL WHERE id=? AND version=?",
      )
      .run(
        next.title,
        next.notes,
        next.draft,
        next.status,
        Date.now(),
        id,
        version,
      );
    if (!result.changes)
      throw Error("This item changed. Refresh before saving.");
    return this.get(id);
  }
  claim(runId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.recover();
      const rows = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='queued' ORDER BY updated LIMIT 2",
        )
        .all();
      for (const row of rows)
        this.db
          .prepare(
            "UPDATE tasks SET status='preparing',version=version+1,updated=?,lease=?,runId=? WHERE id=?",
          )
          .run(Date.now(), Date.now() + 300000, runId, row.id);
      const tasks = rows.map((r) => this.get(r.id));
      this.db.exec("COMMIT");
      return tasks;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  recover(runId) {
    const condition = runId
      ? "runId=? AND status='preparing'"
      : "lease<? AND status='preparing'";
    this.db
      .prepare(
        `UPDATE tasks SET status='needs_info',draft='Preparation stopped before a draft was saved. You can request preparation again.',version=version+1,updated=?,lease=NULL,runId=NULL WHERE ${condition}`,
      )
      .run(Date.now(), runId ?? Date.now());
  }
  close() {
    this.db.close();
  }
}

function validateCaptureKey(source, key) {
  if (
    !["web", "telegram", "assistant"].includes(source) ||
    typeof key !== "string" ||
    key.length > 160 ||
    !key
  )
    throw Error("Invalid capture.");
}

function validatePatch(old, version, patch) {
  if (!Number.isInteger(version) || !patch || typeof patch !== "object")
    throw Error("A current version is required.");
  if (old.version !== version)
    throw Error("This item changed. Refresh before saving.");
  const next = { ...old };
  for (const [key, value] of Object.entries(patch)) {
    validateField(key, value);
    next[key] = value;
  }
  if (!next.title.trim()) throw Error("A title is required.");
  return next;
}
function validateField(key, value) {
  if (!["title", "notes", "draft", "status"].includes(key))
    throw Error("Unsupported task field.");
  if (key === "status") {
    if (!taskStates.includes(value) || value === "preparing")
      throw Error("Invalid task status.");
  } else bounded(value, key === "title" ? 240 : 24000);
}
function validateDraft(old, next, runId) {
  if (
    old.status !== "preparing" ||
    old.runId !== runId ||
    old.lease < Date.now()
  )
    throw Error("Preparation lease is no longer current.");
  if (!["ready", "needs_info"].includes(next.status))
    throw Error("The assistant can only return a draft or a question.");
  if (!next.draft.trim())
    throw Error("Include the prepared draft or the missing information.");
}

function invalidateChangedDraft(old, next, patch) {
  if (old.title !== next.title || old.notes !== next.notes) {
    next.draft = "";
    if (!patch.status) next.status = "inbox";
  }
  if (next.status === "preparing") next.status = "inbox";
}
