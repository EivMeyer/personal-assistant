import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const actionKey = (server, name, args) => digest({ server, name, args });
export const actionDatabase = () =>
  join(homedir(), ".local/share/secretary-actions/actions.sqlite");
export class ActionStore {
  constructor(path = actionDatabase()) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, runId TEXT NOT NULL,
        server TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
        snapshot TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL,
        pid INTEGER, outcome TEXT, finished INTEGER, notified INTEGER
      );`);
    if (
      !this.db
        .prepare("PRAGMA table_info(actions)")
        .all()
        .some((column) => column.name === "notificationLease")
    )
      this.db.exec("ALTER TABLE actions ADD COLUMN notificationLease INTEGER");
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  reserve({ server, name, args, snapshot, runId }, now = Date.now()) {
    if (!runId) throw Error("Missing action run identity");
    this.db
      .prepare(
        "UPDATE actions SET state='expired' WHERE state='pending' AND expires<?",
      )
      .run(now);
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare(
            "SELECT id FROM actions WHERE fingerprint=? AND state='unknown'",
          )
          .get(actionKey(server, name, args))
      )
        throw Error(
          "A matching action has an uncertain outcome. Reconcile delivery before preparing a retry.",
        );
      if (
        this.db
          .prepare(
            "SELECT id FROM actions WHERE state IN ('pending','checking','executing')",
          )
          .get()
      )
        throw Error(
          "Another action is awaiting approval or execution. Resolve it first.",
        );
      this.db
        .prepare(
          "INSERT INTO actions(id,fingerprint,runId,server,tool,args,snapshot,state,expires) VALUES(?,?,?,?,?,?,?,'pending',?)",
        )
        .run(
          id,
          actionKey(server, name, args),
          runId,
          server,
          name,
          JSON.stringify(args),
          JSON.stringify(snapshot),
          now + 130000,
        );
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  claim(server, name, args, now = Date.now()) {
    const row = this.db
      .prepare(
        "UPDATE actions SET state='checking',pid=? WHERE fingerprint=? AND state='pending' AND expires>=? RETURNING *",
      )
      .get(process.pid, actionKey(server, name, args), now);
    if (!row)
      throw Error(
        "Missing, expired, or consumed action review. Prepare a fresh approval.",
      );
    return {
      ...row,
      args: JSON.parse(row.args),
      snapshot: JSON.parse(row.snapshot),
    };
  }
  executing(id) {
    if (
      this.db
        .prepare(
          "UPDATE actions SET state='executing' WHERE id=? AND state='checking'",
        )
        .run(id).changes !== 1
    )
      throw Error("Action is no longer executable");
  }
  finish(id, state, outcome) {
    this.db
      .prepare(
        "UPDATE actions SET state=?,outcome=?,finished=? WHERE id=? AND state IN ('pending','checking','executing')",
      )
      .run(state, JSON.stringify(outcome), Date.now(), id);
  }
  pendingForRun(runId) {
    return this.db
      .prepare(
        "SELECT id,state FROM actions WHERE runId=? AND state IN ('pending','checking','executing') AND expires>=?",
      )
      .all(runId, Date.now());
  }
  receipts() {
    return this.db
      .prepare(
        "SELECT * FROM actions WHERE finished IS NOT NULL AND notified IS NULL ORDER BY finished LIMIT 20",
      )
      .all();
  }
  claimReceipt(id, now = Date.now()) {
    return this.db
      .prepare(
        "UPDATE actions SET notificationLease=? WHERE id=? AND notified IS NULL AND (notificationLease IS NULL OR notificationLease<?) RETURNING *",
      )
      .get(now + 30000, id, now);
  }
  cancelPendingRun(runId) {
    if (!runId) return [];
    return this.db
      .prepare(
        "UPDATE actions SET state='blocked',outcome=?,finished=? WHERE runId=? AND state='pending' RETURNING id",
      )
      .all(
        JSON.stringify({
          message:
            "The requesting turn ended without executing this action. A fresh review is required.",
        }),
        Date.now(),
        runId,
      );
  }
  notified(id) {
    this.db
      .prepare("UPDATE actions SET notified=? WHERE id=?")
      .run(Date.now(), id);
  }
  recover() {
    for (const row of this.db
      .prepare(
        "SELECT id,pid FROM actions WHERE state IN ('checking','executing')",
      )
      .all()) {
      try {
        process.kill(row.pid, 0);
      } catch {
        this.finish(row.id, "unknown", {
          message:
            "Worker stopped before a terminal receipt. Verify the source before retrying.",
        });
      }
    }
  }
  close() {
    this.db.close();
  }
}
