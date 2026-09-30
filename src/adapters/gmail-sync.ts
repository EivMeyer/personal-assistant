import { z } from "zod";
import { ApiError } from "../http.ts";
import type { MailClient } from "./google-client.ts";

const entrySchema = z.object({ id: z.string() });
const historySchema = z.object({
  historyId: z.string(),
  nextPageToken: z.string().optional(),
  history: z
    .array(
      z.object({
        messagesAdded: z.array(z.object({ message: entrySchema })).optional(),
      }),
    )
    .default([]),
});
export async function changedMessages(
  client: MailClient,
  cursor: string,
): Promise<{ ids: string[]; cursor: string }> {
  const ids = new Set<string>();
  let page: string | undefined;
  let nextCursor = cursor;
  do {
    const query = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: "messageAdded",
      maxResults: "500",
    });
    if (page) query.set("pageToken", page);
    const result = historySchema.parse(
      await client.request(`history?${query}`),
    );
    for (const item of result.history)
      for (const added of item.messagesAdded ?? []) ids.add(added.message.id);
    nextCursor = result.historyId;
    page = result.nextPageToken;
  } while (page);
  return { ids: [...ids], cursor: nextCursor };
}
export async function recoverMessages(
  client: MailClient,
  since: number,
): Promise<string[]> {
  const ids: string[] = [];
  let page: string | undefined;
  do {
    const query = new URLSearchParams({
      q: `after:${Math.floor(since / 1000)}`,
      maxResults: "500",
    });
    if (page) query.set("pageToken", page);
    const result = z
      .object({
        messages: z.array(entrySchema).default([]),
        nextPageToken: z.string().optional(),
      })
      .parse(await client.request(`messages?${query}`));
    ids.push(...result.messages.map((message) => message.id));
    page = result.nextPageToken;
  } while (page);
  return ids;
}
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
