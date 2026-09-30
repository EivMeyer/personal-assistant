import assert from "node:assert/strict";
import test from "node:test";
import { planPreview, evaluateAction } from "./index.mjs";
const config = {
  mcp: {
    servers: {
      "gmail-work-actions": {
        args: ["/test/guarded-mcp.mjs"],
        codex: { defaultToolsApprovalMode: "prompt" },
      },
    },
  },
  channels: { telegram: { tokenFile: "/private/token" } },
};
const ctx = {
  requester: {
    channel: "telegram",
    senderId: "700000001",
    senderIsOwner: true,
  },
};
const event = {
  toolName: "gmail-work-actions__send_email",
  params: {
    to: ["recipient@example.invalid"],
    subject: "Test",
    body: "Exact text",
  },
};
test("only the owner can request external execution", () => {
  for (const requester of [
    undefined,
    {},
    { ...ctx.requester, senderId: "other" },
    { ...ctx.requester, channel: "slack" },
    { ...ctx.requester, senderIsOwner: false },
  ]) {
    assert.throws(
      () => planPreview(event, { requester }, config),
      /Telegram owner/,
    );
  }
});
test("explicit approval cannot be replaced by auto approval", () => {
  assert.throws(
    () => planPreview(event, ctx, { mcp: { servers: {} } }),
    /native approval/,
  );
});
test("preview contains complete exact routing and body, and changes get new identity", () => {
  const p = planPreview(event, ctx, config);
  for (const text of ["recipient@example.invalid", "Test", "Exact text"])
    assert.ok(p.chunks.join("").includes(text));
  assert.notEqual(
    p.id,
    planPreview(
      { ...event, params: { ...event.params, body: "Corrected" } },
      ctx,
      config,
    ).id,
  );
  assert.notEqual(
    p.id,
    planPreview(
      {
        ...event,
        params: { ...event.params, to: ["different@example.invalid"] },
      },
      ctx,
      config,
    ).id,
  );
});
test("personal sender is rejected and read tools pass without side effects", () => {
  assert.throws(
    () =>
      planPreview(
        {
          ...event,
          params: { ...event.params, from: "personal@example.invalid" },
        },
        ctx,
        config,
      ),
    /company account/,
  );
  assert.equal(
    planPreview({ toolName: "gmail-work__read_email", params: {} }, {}, config),
    null,
  );
});
test("oversized review blocks rather than silently truncating", () => {
  assert.throws(
    () =>
      planPreview(
        { ...event, params: { ...event.params, body: "x".repeat(24001) } },
        ctx,
        config,
      ),
    /too large/,
  );
});
test("identity failure, transport failure and negative receipt all block", async () => {
  for (const dependencies of [
    {
      verifyIdentity: async () => {
        throw Error("wrong account");
      },
    },
    {
      verifyIdentity: async () => {},
      readToken: async () => "test",
      jsonRequest: async () => {
        throw Error("offline");
      },
    },
    {
      verifyIdentity: async () => {},
      readToken: async () => "test",
      jsonRequest: async () => ({ ok: false }),
    },
  ])
    assert.equal(
      (await evaluateAction(event, ctx, config, dependencies)).block,
      true,
    );
});
test("complete preview goes only to owner, then leaves native gate intact", async () => {
  const calls = [];
  const result = await evaluateAction(event, ctx, config, {
    verifyIdentity: async () => {},
    readToken: async () => "test",
    jsonRequest: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chat_id, "700000001");
  assert.ok(calls[0].text.includes("Exact text"));
});
