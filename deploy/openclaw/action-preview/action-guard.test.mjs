import { addSources } from "./action-schema.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionStore,
  executeGuarded,
  blockPrematureFinal,
  reserveAction,
} from "./action-guard.mjs";
import { sourceRefs } from "./source-snapshot.mjs";
import {
  receiptText,
  registerAbandonedRunStatus,
  registerReceiptDelivery,
} from "./receipt-delivery.mjs";
const server = "setup-approval-fixture";
const args = {
  body: "Final corrected text",
  secretary_sources: [],
  timeoutMs: 210000,
};
function setup(t) {
  const store = new ActionStore(":memory:");
  t.after(() => store.close());
  store.reserve({
    server,
    name: "record_action",
    args,
    snapshot: [{ hash: "r1" }],
    runId: "run-1",
  });
  return store;
}
test("changed context after approval blocks before any side effect", async (t) => {
  const store = setup(t);
  let calls = 0;
  const result = await executeGuarded({
    server,
    name: "record_action",
    args,
    config: {},
    store,
    snapshot: async () => [{ hash: "r2" }],
    invoke: async () => {
      calls++;
    },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
  assert.equal(store.receipts()[0].state, "blocked");
  assert.match(receiptText(store.receipts()[0]), /Nothing sent or changed/);
});
test("unchanged approved action executes exact final arguments once", async (t) => {
  const store = setup(t);
  const calls = [];
  const options = {
    server,
    name: "record_action",
    args,
    config: {},
    store,
    snapshot: async () => [{ hash: "r1" }],
    invoke: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "LOCAL_RECEIPT_RECORDED" }] };
    },
  };
  await executeGuarded(options);
  await assert.rejects(executeGuarded(options), /consumed/);
  assert.deepEqual(calls, [
    { name: "record_action", args: { body: "Final corrected text" } },
  ]);
  assert.equal(store.receipts()[0].state, "completed");
});
test("failed source refresh and changed sender both fail closed", async (t) => {
  for (const failure of ["snapshot", "verify"]) {
    const store = new ActionStore(":memory:");
    t.after(() => store.close());
    store.reserve({
      server,
      name: "record_action",
      args,
      snapshot: [],
      runId: failure,
    });
    let calls = 0;
    const options = {
      server,
      name: "record_action",
      args,
      config: {},
      store,
      snapshot: async () => [],
      verify: async () => {},
      invoke: async () => {
        calls++;
      },
    };
    options[failure] = async () => {
      throw Error("unavailable or changed identity");
    };
    assert.equal((await executeGuarded(options)).isError, true);
    assert.equal(calls, 0);
  }
});
test("connector timeout is uncertain, retained, and cannot retry the consumed approval", async (t) => {
  const store = setup(t);
  const options = {
    server,
    name: "record_action",
    args,
    config: {},
    store,
    snapshot: async () => [{ hash: "r1" }],
    invoke: async () => {
      throw Error("timeout after send");
    },
  };
  assert.equal((await executeGuarded(options)).isError, true);
  assert.equal(store.receipts()[0].state, "unknown");
  await assert.rejects(executeGuarded(options), /consumed/);
});
test("pending action prevents premature finalization and terminal receipt survives model completion", async (t) => {
  const store = setup(t);
  assert.equal(
    blockPrematureFinal({ runId: "run-1" }, {}, store).action,
    "revise",
  );
  assert.equal(blockPrematureFinal({ runId: "other" }, {}, store), undefined);
  const row = store.claim(server, "record_action", args);
  store.finish(row.id, "blocked", { message: "Source changed" });
  assert.equal(blockPrematureFinal({ runId: "run-1" }, {}, store), undefined);
  assert.equal(store.receipts().length, 1);
  store.notified(row.id);
  assert.equal(store.receipts().length, 0);
});
test("only one outstanding review and expired reviews cannot execute", (t) => {
  const store = setup(t);
  assert.throws(
    () =>
      store.reserve({
        server,
        name: "record_action",
        args: { body: "changed" },
        snapshot: [],
        runId: "other",
      }),
    /Another action/,
  );
  assert.throws(
    () => store.claim(server, "record_action", args, Date.now() + 200000),
    /expired/,
  );
});
test("source context includes cross-source references and mandatory destination conversation", () => {
  const refs = sourceRefs("whatsapp-actions", {
    recipient: "4799999999",
    secretary_sources: [{ source: "gmail-work", thread: "email-thread" }],
  });
  assert.deepEqual(refs, [
    { source: "gmail-work", thread: "email-thread" },
    { source: "whatsapp", thread: "4799999999@s.whatsapp.net" },
  ]);
  assert.throws(
    () => sourceRefs("gmail-work-actions", { to: ["test@example.invalid"] }),
    /secretary_sources/,
  );
  assert.deepEqual(
    sourceRefs("gmail-work-actions", { threadId: "t", secretary_sources: [] }),
    [{ source: "gmail-work", thread: "t" }],
  );
  assert.deepEqual(
    sourceRefs("slack-actions", {
      channel_id: "C1",
      thread_ts: "123.45",
      secretary_sources: [],
    }),
    [{ source: "slack", thread: "C1:123.45" }],
  );
});
test("native preview reservation is bound to the exact model call and run", async (t) => {
  const store = new ActionStore(":memory:");
  t.after(() => store.close());
  await reserveAction(
    { toolName: server + "__record_action", params: args, runId: "owner-run" },
    {},
    {},
    store,
    async () => [],
  );
  assert.equal(store.claim(server, "record_action", args).runId, "owner-run");
});

test("structured connector failure cannot produce a success receipt", async (t) => {
  const store = setup(t);
  await executeGuarded({
    server,
    name: "record_action",
    args,
    config: {},
    store,
    snapshot: async () => [{ hash: "r1" }],
    invoke: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: false, message: "not connected" }),
        },
      ],
    }),
  });
  assert.equal(store.receipts()[0].state, "failed");
});
test("receipt lease prevents concurrent plugin instances from delivering the same receipt", (t) => {
  const store = setup(t);
  const row = store.claim(server, "record_action", args);
  store.finish(row.id, "completed", { result: {} });
  assert.ok(store.claimReceipt(row.id, 100));
  assert.equal(store.claimReceipt(row.id, 101), undefined);
  assert.ok(store.claimReceipt(row.id, 30101));
  store.notified(row.id);
  assert.equal(store.claimReceipt(row.id, 70000), undefined);
});
test("abandoned owner run revokes pending review and releases the next action", (t) => {
  const store = setup(t);
  store.cancelPendingRun("unrelated");
  assert.equal(store.pendingForRun("run-1").length, 1);
  store.cancelPendingRun("run-1");
  assert.throws(() => store.claim(server, "record_action", args), /consumed/);
  assert.equal(store.receipts()[0].state, "blocked");
  assert.ok(
    store.reserve({
      server,
      name: "record_action",
      args,
      snapshot: [],
      runId: "new-run",
    }),
  );
});
test("an unknown result cannot be blindly retried with a fresh approval", (t) => {
  const store = setup(t);
  const row = store.claim(server, "record_action", args);
  store.finish(row.id, "unknown", { message: "lost response" });
  assert.throws(
    () =>
      store.reserve({
        server,
        name: "record_action",
        args,
        snapshot: [],
        runId: "retry",
      }),
    /uncertain outcome/,
  );
});

test("abandoned action reports the durable verdict instead of a stale model status", (t) => {
  const store = setup(t);
  const hooks = {};
  registerAbandonedRunStatus(
    {
      on: (name, fn) => {
        hooks[name] = fn;
      },
    },
    store,
  );
  hooks.agent_end({ runId: "run-1" }, { sessionKey: "owner" });
  assert.equal(
    hooks.message_sending(
      { to: "700000001", content: "Cannot confirm execution" },
      { channelId: "telegram", sessionKey: "owner" },
    ).cancel,
    true,
  );
  assert.equal(
    hooks.message_sending(
      { to: "700000001" },
      { channelId: "telegram", sessionKey: "unrelated" },
    ),
    undefined,
  );
  hooks.message_received({}, { sessionKey: "owner" });
  assert.equal(
    hooks.message_sending(
      { to: "700000001" },
      { channelId: "telegram", sessionKey: "owner" },
    ),
    undefined,
  );
});
test("receipt timer is owned by the plugin service lifecycle", (t) => {
  const store = setup(t);
  let service;
  registerReceiptDelivery(
    {
      registerService: (value) => {
        service = value;
      },
    },
    store,
  );
  assert.equal(service.id, "secretary-receipts");
  service.start();
  service.stop();
});

test("approval tools declare enough outer time and preserve original input constraints", async () => {
  const result = addSources({
    tools: [
      {
        name: "send",
        description: "Send",
        inputSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
    ],
  });
  const schema = result.tools[0].inputSchema;
  assert.deepEqual(schema.required, ["body", "secretary_sources", "timeoutMs"]);
  assert.equal(schema.properties.timeoutMs.const, 210000);
  assert.equal(schema.additionalProperties, false);
});
