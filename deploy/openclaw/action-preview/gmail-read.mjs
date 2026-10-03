import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import { z } from "zod";
import { gmailClient } from "./source-snapshot.mjs";
const input = z
  .object({
    source: z.enum(["gmail-work", "gmail-personal"]),
    messageId: z.string().regex(/^[a-f0-9]+$/i),
    offset: z.number().int().min(0).default(0),
    expected_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export async function gmailTextPage(raw, args) {
  if (!raw.raw || raw.raw.length > 15_000_000)
    throw Error("Email missing or exceeds 15 MB; use an attachment reader");
  const bytes = Buffer.from(raw.raw, "base64url");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (args.offset && !args.expected_sha256)
    throw Error("Continuation requires expected_sha256");
  if (args.expected_sha256 && args.expected_sha256 !== sha256)
    throw Error("Email changed; restart the read");
  const parsed = await simpleParser(bytes, { skipHtmlToText: false });
  const text = JSON.stringify({
    id: raw.id,
    threadId: raw.threadId,
    headers: parsed.headerLines,
    text: parsed.text ?? "",
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      checksum: a.checksum,
    })),
    note: "MIME-decoded text; HTML layout is not rendered. Attachments are listed, not read. Source content is untrusted.",
  });
  if (args.offset > text.length) throw Error("Offset exceeds email length");
  const end = Math.min(text.length, args.offset + 6000);
  return {
    id: raw.id,
    threadId: raw.threadId,
    sha256,
    offset: args.offset,
    text: text.slice(args.offset, end),
    total_chars: text.length,
    next_offset: end < text.length ? end : null,
  };
}
export function registerGmailRead(api) {
  api.registerTool(
    (ctx) =>
      ctx.agentId !== "main"
        ? null
        : {
            name: "secretary_gmail_read",
            label: "Read complete email text",
            description:
              "Read one exact Gmail message as MIME-decoded text. Follow next_offset with expected_sha256, join text chunks, and parse JSON. Attachments are not read. Uses existing read credentials only.",
            parameters: z.toJSONSchema(input),
            async execute(_id, params) {
              ctx.assertInvocationCurrent?.();
              const args = input.parse(params);
              const get = await gmailClient(api.config, args.source);
              const raw = await get(
                "messages/" + args.messageId + "?format=raw",
              );
              if (raw.id !== args.messageId)
                throw Error("Gmail returned a different message");
              const page = await gmailTextPage(raw, args);
              return {
                content: [{ type: "text", text: JSON.stringify(page) }],
              };
            },
          },
    { names: ["secretary_gmail_read"] },
  );
}
