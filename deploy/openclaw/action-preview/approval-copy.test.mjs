import assert from "node:assert/strict";
import test from "node:test";
import { actionPreviewText, actionReceiptText } from "./approval-copy.mjs";
import { slackDestination } from "./slack-destination.mjs";
import {
  isSecretaryApproval,
  secretaryApprovalActions,
  secretaryApprovalStatus,
} from "./telegram-approval-copy.mjs";
import { patchTelegramApproval } from "./telegram-approval-patch.mjs";
const view = {
  approvalKind: "plugin",
  toolName: "codex_mcp_tool_approval",
  description: "Tool: Send Message\nMCP server: slack-actions\nMessage details",
  phase: "pending",
};
test("approval shows exact message and verified person, without protocol fields", () => {
  const text = actionPreviewText({
    tool: "conversations_add_message",
    identity: "Test Owner · The Open Engine",
    destination: "Test Person on Slack",
    params: {
      channel_id: "D_EXAMPLE",
      text: "Keep these exact words!\nSecond line",
      secretary_sources: [{ source: "slack", thread: "D_EXAMPLE" }],
      timeoutMs: 210000,
    },
  });
  assert.match(text, /To: Test Person on Slack/);
  assert.match(text, /Keep these exact words!\nSecond line/);
  assert.doesNotMatch(
    text,
    /D_EXAMPLE|secretary_sources|210000|conversations_add_message|Exact arguments/,
  );
});
test("email routing, attachments and unrecognized effect fields stay visible", () => {
  const params = {
    to: ["to@example.invalid"],
    cc: ["cc@example.invalid"],
    bcc: ["bcc@example.invalid"],
    subject: "Hello",
    body: "Exact body",
    attachments: ["invoice.pdf"],
    new_effect: "Never hide me",
  };
  const text = actionPreviewText({
    tool: "send_email",
    params,
    identity: "owner@theopenengine.com",
  });
  for (const value of Object.values(params).flat())
    assert.ok(text.includes(value));
});
test("Slack names come from the destination account, not message text", async () => {
  const config = {
    mcp: {
      servers: { "slack-actions": { env: { SLACK_MCP_XOXP_TOKEN: "test" } } },
    },
  };
  const replies = [
    { ok: true, channel: { id: "D_EXAMPLE", is_im: true, user: "U_EXAMPLE" } },
    {
      ok: true,
      user: {
        id: "U_EXAMPLE",
        team_id: "TTEAM",
        real_name: "Verified Person",
      },
    },
  ];
  const request = async () => ({ ok: true, json: async () => replies.shift() });
  assert.equal(
    await slackDestination({ channel_id: "D_EXAMPLE" }, config, request),
    "Verified Person on Slack",
  );
  await assert.rejects(
    slackDestination({ channel_id: "D_OTHER" }, config, async () => ({
      ok: true,
      json: async () => ({ ok: true, channel: { id: "D_EXAMPLE" } }),
    })),
    /does not match/,
  );
});
test("friendly buttons retain exact native approval callbacks and omit persistent grants", () => {
  const actions = ["allow-once", "allow-always", "deny"].map((decision) => ({
    decision,
    label: decision,
    action: {
      type: "approval",
      approvalId: "native-id",
      approvalKind: "plugin",
      decision,
    },
  }));
  const result = secretaryApprovalActions({ ...view, actions });
  assert.deepEqual(
    result.map((a) => a.label),
    ["Go ahead", "Change / cancel"],
  );
  assert.equal(result[0].action, actions[0].action);
  assert.equal(result[1].action, actions[2].action);
  assert.equal(isSecretaryApproval(view), true);
  assert.equal(
    isSecretaryApproval({
      ...view,
      toolName: "slack-actions__conversations_add_message",
      description: "Native per-call review",
    }),
    true,
  );
  assert.equal(
    isSecretaryApproval({ ...view, description: "MCP server: unrelated" }),
    false,
  );
  assert.equal(isSecretaryApproval({ ...view, approvalKind: "exec" }), false);
  assert.match(
    secretaryApprovalStatus({
      ...view,
      phase: "resolved",
      decision: "allow-once",
    }),
    /confirm when/,
  );
  assert.match(
    secretaryApprovalStatus({ ...view, phase: "resolved", decision: "deny" }),
    /Cancelled/,
  );
  assert.match(
    secretaryApprovalStatus({ ...view, phase: "expired" }),
    /expired/,
  );
});
test("receipt distinguishes completed, blocked, failed and uncertain delivery", () => {
  const row = {
    args: JSON.stringify({ text: "Exact message" }),
    outcome: "{}",
    server: "slack-actions",
    tool: "conversations_add_message",
  };
  assert.equal(
    actionReceiptText({ ...row, state: "completed" }),
    "Sent on Slack.\n\nExact message",
  );
  assert.equal(
    actionReceiptText({
      ...row,
      args: "{}",
      server: "google-work-actions",
      tool: "calendar_create",
      state: "completed",
    }),
    "Appointment created.",
  );
  assert.match(
    actionReceiptText({ ...row, state: "blocked" }),
    /Nothing sent or changed/,
  );
  assert.match(
    actionReceiptText({ ...row, state: "failed" }),
    /didn’t go through/,
  );
  assert.doesNotMatch(
    actionReceiptText({ ...row, state: "unknown" }),
    /Sent|Nothing sent/,
  );
  assert.equal(
    actionReceiptText({
      ...row,
      state: "completed",
      args: JSON.stringify({ text: "x".repeat(12000) }),
    }),
    "Sent on Slack.",
  );
});
test("Telegram patch is scoped, idempotent and rejects changed upstream layout", () => {
  const source =
    "function buildPendingPayload(params) {\nreturn {};\n}\nconst resolved = {text: buildTelegramNativeResolvedApprovalText(view)};\nconst expired = {text: buildTelegramNativeExpiredApprovalText(view)};";
  const patched = patchTelegramApproval(source, "file:///test/helper.mjs");
  assert.match(patched, /if \(isSecretaryApproval\(params.view\)\)/);
  assert.match(
    patched,
    /secretaryApprovalStatus\(view\) \?\? buildTelegramNativeResolvedApprovalText/,
  );
  assert.equal(
    patchTelegramApproval(patched, "file:///test/helper.mjs"),
    patched,
  );
  assert.throws(
    () =>
      patchTelegramApproval("different upstream", "file:///test/helper.mjs"),
    /Unexpected/,
  );
});
