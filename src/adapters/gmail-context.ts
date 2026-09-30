import { z } from "zod";
import type { Message } from "../domain.ts";
import type { MailClient } from "./google-client.ts";
import {
  decodeMessage,
  rawMessageSchema,
  validMailbox,
} from "./gmail-message.ts";

interface ContextReader {
  client: MailClient;
  source: string;
  ownEmails: string[];
}
export async function readThread(
  reader: ContextReader,
  thread: string,
): Promise<Message[]> {
  const result = z
    .object({ messages: z.array(z.object({ id: z.string() })) })
    .parse(
      await reader.client.request(
        `threads/${encodeURIComponent(thread)}?format=minimal`,
      ),
    );
  const messages: Message[] = [];
  for (const entry of result.messages)
    messages.push(await readRaw(reader, entry.id));
  return messages;
}
async function readRaw(reader: ContextReader, id: string): Promise<Message> {
  const raw = rawMessageSchema.parse(
    await reader.client.request(
      `messages/${encodeURIComponent(id)}?format=raw`,
    ),
  );
  return decodeMessage(raw, reader.source, reader.ownEmails);
}
export async function relatedSentContext(
  reader: ContextReader,
  original: Message[],
): Promise<Message[]> {
  const addresses = [
    ...new Set(
      original
        .filter((message) => !message.outgoing)
        .map((message) => message.sender),
    ),
  ].filter(validMailbox);
  if (!addresses.length) return [];
  if (addresses.length > 20)
    throw new Error(
      "Too many email participants to verify related company replies",
    );
  const earliest =
    Math.min(...original.map((message) => message.timestamp)) - 86_400_000;
  const query = `in:sent {${addresses.map((email) => `to:${email}`).join(" ")}} after:${Math.floor(earliest / 1000)}`;
  const ids = await sentCandidates(reader.client, query);
  const candidates: Message[] = [];
  for (const id of ids) candidates.push(await readRaw(reader, id));
  const known = new Set(original.flatMap(messageIds));
  const related = candidates.filter((message) =>
    messageIds(message).some((id) => known.has(id)),
  );
  const threads = [...new Set(related.map((message) => message.thread))];
  const messages: Message[] = [];
  for (const thread of threads)
    messages.push(...(await readThread(reader, thread)));
  return messages;
}
function messageIds(message: Message): string[] {
  return [
    ...(message.references ?? []),
    ...(message.rfcMessageId ? [message.rfcMessageId] : []),
  ];
}
async function sentCandidates(
  client: MailClient,
  query: string,
): Promise<string[]> {
  const result = z
    .object({
      messages: z.array(z.object({ id: z.string() })).default([]),
      nextPageToken: z.string().optional(),
    })
    .parse(
      await client.request(
        `messages?${new URLSearchParams({ q: query, maxResults: "100" })}`,
      ),
    );
  if (result.nextPageToken)
    throw new Error(
      "Related company mail exceeds context search limit; manual review required",
    );
  return result.messages.map((message) => message.id);
}
export function mergeMessages(messages: Message[]): Message[] {
  const unique = new Map<string, Message>();
  for (const message of messages)
    unique.set(
      message.rfcMessageId ?? `${message.source}:${message.id}`,
      message,
    );
  return [...unique.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
}
