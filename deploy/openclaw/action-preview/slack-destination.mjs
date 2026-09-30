import { ownerProfile } from "./owner-profile.mjs";
import { slackToken } from "./slack-auth.mjs";
export async function slackDestination(params, config, request = fetch) {
  const token = slackToken(config);
  async function get(method, query) {
    const result = await request(
      "https://slack.com/api/" + method + "?" + new URLSearchParams(query),
      {
        headers: { Authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!result.ok) throw Error("Could not verify the Slack recipient");
    const data = await result.json();
    if (!data.ok) throw Error("Could not verify the Slack recipient");
    return data;
  }
  const { channel } = await get("conversations.info", {
    channel: params.channel_id,
  });
  if (channel.id !== params.channel_id)
    throw Error("Slack recipient does not match the proposed action");
  if (channel.is_im) {
    const { user } = await get("users.info", { user: channel.user });
    if (user.id !== channel.user || user.team_id !== ownerProfile().slackTeamId)
      throw Error("Could not verify the Slack recipient’s workspace");
    return (user.real_name || user.name) + " on Slack";
  }
  return "#" + (channel.name ?? channel.id) + " on Slack";
}
