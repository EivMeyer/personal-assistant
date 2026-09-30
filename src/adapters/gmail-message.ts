import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import type { Message } from "../domain.ts";

export const rawMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.string(),
  raw: z.string(),
  labelIds: z.array(z.string()).default([]),
});
export type RawMessage = z.infer<typeof rawMessageSchema>;
export async function decodeMessage(
  raw: RawMessage,
  source: string,
  ownEmails: string[],
): Promise<Message> {
  if (raw.raw.length > 15_000_000) return oversizedMessage(raw, source);
  const parsed = await simpleParser(Buffer.from(raw.raw, "base64url"), {
    skipHtmlToText: false,
  });
  const sender = parsed.from?.value[0]?.address ?? "";
  const replyTo = parsed.replyTo?.value[0]?.address ?? sender;
  const timestamp = Number(raw.internalDate);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid Gmail timestamp");
  return {
    id: raw.id,
    source,
    thread: raw.threadId,
    channel: "gmail",
    timestamp,
    sender,
    replyTo,
    subject: parsed.subject ?? "",
    body: parsed.text ?? "",
    rfcMessageId: parsed.messageId,
    references: extractReferences(parsed),
    outgoing:
      raw.labelIds.includes("SENT") || ownEmails.includes(sender.toLowerCase()),
    automated: isAutomated(parsed.headers, raw.labelIds),
    attachments: hasUnsupportedContent(parsed),
  };
}
function oversizedMessage(raw: RawMessage, source: string): Message {
  return {
    id: raw.id,
    source,
    thread: raw.threadId,
    channel: "gmail",
    timestamp: Number(raw.internalDate),
    sender: "Unavailable: message exceeds size limit",
    body: "",
    outgoing: raw.labelIds.includes("SENT"),
    automated: false,
    attachments: true,
  };
}
function extractReferences(parsed: ParsedMail): string[] {
  const references =
    typeof parsed.references === "string"
      ? [parsed.references]
      : (parsed.references ?? []);
  return parsed.inReplyTo ? [...references, parsed.inReplyTo] : references;
}
function hasUnsupportedContent(parsed: ParsedMail): boolean {
  if (parsed.attachments.length > 0) return true;
  if (parsed.from?.value.length !== 1) return true;
  return parsed.replyTo !== undefined && parsed.replyTo.value.length !== 1;
}
function isAutomated(headers: Map<string, unknown>, labels: string[]): boolean {
  if (
    ["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS"].some((label) =>
      labels.includes(label),
    )
  )
    return true;
  if (headers.has("list-unsubscribe") || headers.has("list-id")) return true;
  const autoSubmitted = headers.get("auto-submitted");
  return (
    typeof autoSubmitted === "string" && autoSubmitted.toLowerCase() !== "no"
  );
}
export function validMailbox(value: string): boolean {
  return z.email().safeParse(value).success && !/[\r\n]/.test(value);
}
