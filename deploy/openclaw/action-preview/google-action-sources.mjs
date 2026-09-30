import { readFile } from "node:fs/promises";
import { companyToken, googleJson } from "./google-auth.mjs";
import { eventBase } from "./google-calendar-actions.mjs";
import { documentUrl, fileUrl } from "./google-document-actions.mjs";
export async function googleActionSettings(config) {
  const path =
    config.mcp.servers["google-work-actions"].env.SECRETARY_GOOGLE_SETTINGS;
  return JSON.parse(await readFile(path, "utf8"));
}
export async function verifyGoogleActionIdentity(config) {
  await companyToken(await googleActionSettings(config));
}
export function googleTargetRefs(args) {
  const refs = [];
  if (args.eventId) refs.push({ source: "google-event", thread: args.eventId });
  if (args.documentId)
    refs.push({ source: "google-document", thread: args.documentId });
  if (args.start)
    refs.push({
      source: "google-window",
      thread: JSON.stringify([args.start, args.end]),
    });
  return refs;
}
export async function googleSourceSnapshot(config, ref) {
  const settings = await googleActionSettings(config);
  const headers = await companyToken(settings);
  const get = (url) => googleJson(url, { headers });
  if (ref.source === "google-event")
    return get(eventBase + "/" + encodeURIComponent(ref.thread));
  if (ref.source === "google-document")
    return {
      file: await get(fileUrl(ref.thread)),
      document: await get(documentUrl(ref.thread) + "?includeTabsContent=true"),
    };
  const [timeMin, timeMax] = JSON.parse(ref.thread);
  const query = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    maxResults: "2500",
    orderBy: "startTime",
  });
  const events = await get(eventBase + "?" + query);
  if (events.nextPageToken) throw Error("Calendar window too large to verify");
  return events.items ?? [];
}
