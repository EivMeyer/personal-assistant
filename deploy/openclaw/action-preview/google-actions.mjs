import { serveGoogle } from "./google-stdio.mjs";
import { pathToFileURL } from "node:url";
import { companyToken, googleJson } from "./google-auth.mjs";
import {
  googleActionTools,
  parseGoogleAction,
} from "./google-action-schema.mjs";
import { calendarOperation } from "./google-calendar-actions.mjs";
import { documentOperation } from "./google-document-actions.mjs";
const content = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
export async function callGoogleAction(name, input, settings, request = fetch) {
  let operation;
  let headers;
  try {
    const args = parseGoogleAction(name, input);
    headers = await companyToken(settings, request);
    const get = (url) => googleJson(url, { headers }, request);
    operation = await (
      name.startsWith("calendar_") ? calendarOperation : documentOperation
    )(name, args, get);
  } catch (error) {
    return {
      isError: true,
      ...content({ error: error.message, executed: false }),
    };
  }
  const { url, ...options } = operation;
  // No retry: network/5xx outcomes propagate to the durable guard as unknown.
  const response = await request(url, {
    ...options,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      ...options.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (response.status >= 500 || response.status === 408)
    throw Error("Google write outcome unknown (HTTP " + response.status + ")");
  if (!response.ok)
    return {
      isError: true,
      ...content({
        error: "Google rejected the write",
        httpStatus: response.status,
        executed: false,
      }),
    };
  const result =
    response.status === 204 ? { deleted: true } : await response.json();
  return content({ action: name, result });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await serveGoogle(
    {
      name: "secretary-google-actions",
      tools: googleActionTools,
      call: callGoogleAction,
    },
    process.argv[2],
  );
