import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.ts";
import { Store } from "../src/store.ts";
import { conversation, harness } from "./helpers.ts";

test("ingestion deduplicates and coalesces bursts before triage", async (t) => {
  const h = harness();
  t.after(h.close);
  const first = h.source.context.messages[0]!;
  h.store.ingest("fake", [first, first], "cursor1", h.engine.now());
  await h.engine.processJobs();
  assert.equal(h.planner.calls, 0);
  h.advance(5000);
  h.store.ingest(
    "fake",
    [{ ...first, id: "second" }],
    "cursor2",
    h.engine.now(),
  );
  h.advance(6000);
  await h.engine.processJobs();
  assert.equal(h.planner.calls, 0);
  h.advance(5000);
  await h.engine.processJobs();
  assert.equal(h.planner.calls, 1);
  h.store.ingest("fake", [first], "cursor3", h.engine.now());
  assert.equal(h.store.jobs(Infinity).length, 0);
  assert.equal(h.store.get("cursor:fake"), "cursor3");
});
test("checkpoint and messages survive reopening the database", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.db");
  const store = new Store(openDatabase(path));
  store.ingest("fake", conversation().messages, "checkpoint", 1000);
  store.db.close();
  const reopened = new Store(openDatabase(path));
  t.after(() => reopened.db.close());
  assert.equal(reopened.get("cursor:fake"), "checkpoint");
  assert.equal(reopened.jobs(20_000).length, 1);
});
test("transaction failure does not advance the source checkpoint", (t) => {
  const h = harness();
  t.after(h.close);
  const message = h.source.context.messages[0]!;
  h.store.db.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk simulation'); END",
  );
  assert.throws(() => h.store.ingest("fake", [message], "lost", 1000));
  assert.equal(h.store.get("cursor:fake"), undefined);
});
test("automated messages and configured muted threads bypass the model", async (t) => {
  const h = harness();
  t.after(h.close);
  h.source.context.messages[0]!.automated = true;
  await h.propose();
  assert.equal(h.planner.calls, 0);
  h.source.context.messages[0]!.automated = false;
  h.engine.options.mutedThreads.push("fake:alice");
  await h.propose();
  assert.equal(h.planner.calls, 0);
});
test("daily model cap preserves a retryable job", async (t) => {
  const h = harness();
  t.after(h.close);
  h.engine.options.maxAssessmentsPerDay = 1;
  await h.propose();
  h.store.schedule("fake", "alice", 0);
  await h.engine.processJobs();
  assert.equal(h.planner.calls, 1);
  assert.equal(h.store.jobs(h.engine.now() + 60_000).length, 1);
});
