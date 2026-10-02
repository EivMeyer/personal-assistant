import { boundedAttachmentBody } from "./media-read-common.mjs";
import { createHash } from "node:crypto";
import { slackToken, verifySlackIdentity } from "./slack-auth.mjs";
const LIMIT = 100 * 1024 * 1024;
const cached = new Map();
async function download(url, token, request) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "files.slack.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      throw Error(
        "Slack attachment URL is outside the authenticated file service",
      );
    const response = await request(parsed.href, {
      headers: { Authorization: "Bearer " + token },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw Error("Slack attachment redirect has no destination");
      url = new URL(location, parsed).href;
    } else return boundedAttachmentBody(response, LIMIT, "Slack");
  }
  throw Error("Too many Slack attachment redirects");
}
async function fileMetadata(fileId, token, request) {
  const response = await request(
    "https://slack.com/api/files.info?file=" + fileId,
    {
      headers: { Authorization: "Bearer " + token },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw Error("Slack file metadata read failed");
  const info = await response.json();
  if (info.error === "missing_scope")
    throw Error(
      "Slack media requires the files:read user scope and reauthorization of the existing company Slack app",
    );
  const file = info.file;
  if (
    !info.ok ||
    file?.id !== fileId ||
    typeof file.url_private_download !== "string"
  )
    throw Error("Slack file is unavailable to the verified account");
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > LIMIT)
    throw Error("Slack attachment exceeds the supported size");
  const kind = String(file.mimetype).split("/")[0];
  if (!["image", "audio", "video"].includes(kind))
    throw Error("Unsupported Slack media type");
  return { file, kind };
}
export async function verifiedSlackFile(fileId, options = {}) {
  if (!/^F[A-Z0-9]+$/.test(fileId))
    throw Error("An exact Slack file ID is required");
  const request = options.request ?? fetch;
  const token = options.token ?? slackToken({});
  await (options.verify ?? verifySlackIdentity)({}, request, {
    SLACK_MCP_XOXP_TOKEN: token,
  });
  const cache = options.cache ?? cached;
  const prior = cache.get(fileId);
  if (prior && Date.now() - prior.capturedAt < 300000) return prior;
  const { file, kind } = await fileMetadata(fileId, token, request);
  const bytes = await download(file.url_private_download, token, request);
  if (bytes.length !== file.size)
    throw Error("Slack attachment size does not match its metadata");
  const result = {
    bytes,
    kind,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fileId,
    name: file.name,
    capturedAt: Date.now(),
  };
  if (cache.size >= 2) cache.delete(cache.keys().next().value);
  cache.set(fileId, result);
  return result;
}
