import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import {
  assertReply,
  latestIncoming,
  type Conversation,
  type Message,
  type Proposal,
  type Route,
  type Source,
} from "../domain.ts";
import { Store } from "../store.ts";
import { verifyMailbox, type MailClient } from "./google-client.ts";
import {
  decodeMessage,
  rawMessageSchema,
  validMailbox,
} from "./gmail-message.ts";
import { changedMessages, isNotFound, recoverMessages } from "./gmail-sync.ts";
import {
  readThread,
  relatedSentContext,
  mergeMessages,
} from "./gmail-context.ts";

interface GmailOptions {
  id: string;
  email: string;
  client: MailClient;
  sender: { id: string; email: string; client: MailClient };
  ownEmails: string[];
}
export class GmailSource implements Source {
  readonly id: string;
  constructor(
    private readonly options: GmailOptions,
    private readonly store: Store,
  ) {
    this.id = `gmail-${options.id}`;
  }
  async verify(): Promise<void> {
    await verifyMailbox(this.options.client, this.options.email);
    if (this.options.sender.email !== "eivind@theopenengine.com")
      throw new Error("Company sender required");
    await verifyMailbox(this.options.sender.client, this.options.sender.email);
  }
  async poll(): Promise<void> {
    const cursor = this.store.get(`cursor:${this.id}`);
    const latest = await verifyMailbox(this.options.client, this.options.email);
    if (!cursor) {
      this.store.ingest(this.id, [], latest, Date.now());
      return;
    }
    const changes = await this.changes(cursor, latest);
    const messages: Message[] = [];
    for (const id of changes.ids) {
      const message = await this.read(id);
      if (message) messages.push(message);
    }
    this.store.ingest(this.id, messages, changes.cursor, Date.now());
  }
  private async changes(
    cursor: string,
    latest: string,
  ): Promise<{ ids: string[]; cursor: string }> {
    try {
      return await changedMessages(this.options.client, cursor);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const since =
        Number(this.store.get(`sync:${this.id}`) ?? Date.now()) - 86_400_000;
      const ids = await recoverMessages(this.options.client, since);
      this.store.audit(
        "gmail_history_recovery",
        this.id,
        "History expired; recovered overlapping mailbox window",
        Date.now(),
      );
      return { ids, cursor: latest };
    }
  }
  private async read(id: string): Promise<Message | undefined> {
    try {
      const raw = rawMessageSchema.parse(
        await this.options.client.request(
          `messages/${encodeURIComponent(id)}?format=raw`,
        ),
      );
      return await decodeMessage(raw, this.id, this.options.ownEmails);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
  async conversation(thread: string): Promise<Conversation> {
    const reader = {
      client: this.options.client,
      source: this.id,
      ownEmails: this.options.ownEmails,
    };
    const original = await readThread(reader, thread);
    const related =
      this.options.id === this.options.sender.id
        ? []
        : await relatedSentContext(
            {
              ...reader,
              client: this.options.sender.client,
              source: `gmail-${this.options.sender.id}`,
            },
            original,
          );
    const messages = mergeMessages([...original, ...related]);
    const gaps: string[] = [];
    if (messages.some((message) => message.attachments))
      gaps.push("Attachment or ambiguous sender requires review in Gmail");
    if (messages.some((message) => !message.body))
      gaps.push("A message has no readable text");
    return {
      source: this.id,
      thread,
      messages,
      complete: gaps.length === 0,
      gaps,
    };
  }
  async route(context: Conversation): Promise<Route | null> {
    const incoming = latestIncoming(context);
    if (!incoming) return null;
    const to = incoming.replyTo ?? incoming.sender;
    if (!validMailbox(to)) return null;
    const subject = incoming.subject ?? "";
    if (subject.length > 300 || /[\r\n]/.test(subject)) return null;
    return {
      channel: "gmail",
      account: this.options.sender.id,
      from: this.options.sender.email,
      to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      ...(this.options.id === this.options.sender.id
        ? { thread: context.thread }
        : {}),
      inReplyTo: incoming.rfcMessageId,
      references: replyReferences(incoming),
    };
  }
  async send(proposal: Proposal): Promise<string> {
    assertReply(proposal);
    await verifyMailbox(this.options.sender.client, "eivind@theopenengine.com");
    const route = proposal.route;
    if (route.channel !== "gmail" || route.account !== this.options.sender.id)
      throw new Error("Wrong sending account");
    const raw = await new MailComposer({
      from: route.from,
      to: route.to,
      subject: route.subject,
      text: proposal.assessment.draft!,
      inReplyTo: route.inReplyTo,
      references: route.references,
      messageId: `<assistant.${proposal.id}.v${proposal.version}@theopenengine.com>`,
    })
      .compile()
      .build();
    const result = z.object({ id: z.string() }).parse(
      await this.options.sender.client.request("messages/send", {
        raw: raw.toString("base64url"),
        ...(route.thread ? { threadId: route.thread } : {}),
      }),
    );
    return `gmail:${result.id}`;
  }
}
function replyReferences(incoming: Message): string[] {
  const references = incoming.references ?? [];
  return incoming.rfcMessageId
    ? [...references, incoming.rfcMessageId]
    : references;
}
