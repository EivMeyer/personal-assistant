import test from "node:test";
import assert from "node:assert/strict";
import { slackToken, verifySlackIdentity } from "./slack-auth.mjs";
const configured = (value) => ({
  mcp: {
    servers: { "slack-actions": { env: { SLACK_MCP_XOXP_TOKEN: value } } },
  },
});
test("Slack guard uses the credential actually forwarded to the connector", () => {
  assert.equal(
    slackToken(configured("${SLACK_USER_TOKEN}"), {
      SLACK_MCP_XOXP_TOKEN: "connector",
    }),
    "connector",
  );
  assert.equal(slackToken(configured("resolved"), {}), "resolved");
  assert.equal(
    slackToken(configured("${SLACK_USER_TOKEN}"), {
      SLACK_USER_TOKEN: "gateway",
    }),
    "gateway",
  );
  assert.equal(
    slackToken(configured("old"), {
      SLACK_MCP_XOXP_TOKEN: "actual",
      SLACK_USER_TOKEN: "different",
    }),
    "actual",
  );
  assert.throws(
    () => slackToken(configured("${SLACK_USER_TOKEN}"), {}),
    /unavailable/,
  );
});
test("post-approval identity succeeds in scrubbed MCP environment and rejects wrong account/team", async () => {
  const env = { SLACK_MCP_XOXP_TOKEN: "fixture" };
  const requests = [];
  await verifySlackIdentity(
    configured("${SLACK_USER_TOKEN}"),
    async (url, options) => {
      requests.push({ url, options });
      return Response.json({
        ok: true,
        user_id: "UOWNER",
        team_id: "TTEAM",
      });
    },
    env,
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer fixture");
  for (const auth of [
    { ok: false },
    { ok: true, user_id: "other", team_id: "TTEAM" },
    { ok: true, user_id: "UOWNER", team_id: "other" },
  ]) {
    await assert.rejects(
      verifySlackIdentity({}, async () => Response.json(auth), env),
      /identity/,
    );
  }
});
