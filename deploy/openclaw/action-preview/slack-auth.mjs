import { ownerProfile } from "./owner-profile.mjs";
export function slackToken(config, env = process.env) {
  const configured =
    config.mcp?.servers?.["slack-actions"]?.env?.SLACK_MCP_XOXP_TOKEN;
  const value = env.SLACK_MCP_XOXP_TOKEN ?? configured;
  if (typeof value === "string" && value.trim() && !value.includes("${"))
    return value;
  const fallback = env.SLACK_USER_TOKEN;
  if (typeof fallback === "string" && fallback.trim()) return fallback;
  throw Error("Slack connector credential is unavailable; nothing executed");
}
export async function verifySlackIdentity(
  config,
  request = fetch,
  env = process.env,
) {
  const response = await request("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: "Bearer " + slackToken(config, env) },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error("Slack identity check failed (HTTP " + response.status + ")");
  const auth = await response.json();
  if (
    !auth.ok ||
    auth.user_id !== ownerProfile().slackUserId ||
    auth.team_id !== ownerProfile().slackTeamId
  )
    throw Error("Slack sending identity could not be verified");
}
