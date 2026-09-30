import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { GmailSource } from "../src/adapters/gmail.ts";
import { changedMessages } from "../src/adapters/gmail-sync.ts";
import { decodeMessage } from "../src/adapters/gmail-message.ts";
import {
  verifyMailbox,
  type MailClient,
} from "../src/adapters/google-client.ts";
import { ApiError } from "../src/http.ts";
import { harness } from "./helpers.ts";

function rawMail(id = "mail1", labels: string[] = ["INBOX"]) {
  return {
    id,
    threadId: "thread1",
    internalDate: "1000",
    labelIds: labels,
    raw: Buffer.from(
      "From: Alice <alice@example.com>\r\nTo: personal@example.com\r\nReply-To: reply@example.com\r\nSubject: Project update\r\nMessage-ID: <root@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCould you send an update?",
    ).toString("base64url"),
  };
}
class MailFake implements MailClient {
  calls: { path: string; body?: unknown }[] = [];
  constructor(
    readonly email: string,
    readonly respond: (path: string) => unknown = () => ({}),
  ) {}
  async request(path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ path, body });
    if (path === "profile")
      return { emailAddress: this.email, historyId: "100" };
    if (path === "messages/send") return { id: "sent1" };
    return this.respond(path);
  }
}
test("Gmail MIME decoding preserves full body, sender and Reply-To", async () => {
  const message = await decodeMessage(rawMail(), "gmail-private", [
    "personal@example.com",
  ]);
  assert.equal(message.sender, "alice@example.com");
  assert.equal(message.replyTo, "reply@example.com");
  assert.equal(message.body.trim(), "Could you send an update?");
  assert.equal(message.attachments, false);
});
test("oversized messages become manual-review events instead of blocking mailbox ingestion", async () => {
  const message = await decodeMessage(
    { ...rawMail(), raw: "A".repeat(15_000_001) },
    "gmail-company",
    [],
  );
  assert.equal(message.attachments, true);
  assert.equal(message.body, "");
  assert.equal(message.id, "mail1");
});
test("mailbox identity must match the actual authenticated account", async () => {
  await assert.rejects(
    verifyMailbox(
      new MailFake("personal@example.com"),
      "eivind@theopenengine.com",
    ),
    /differs/,
  );
});
test("Gmail history consumes all pages and deduplicates IDs", async () => {
  const client = new MailFake("eivind@theopenengine.com", (path) =>
    path.includes("pageToken=next")
      ? {
          historyId: "105",
          history: [
            {
              messagesAdded: [
                { message: { id: "a" } },
                { message: { id: "b" } },
              ],
            },
          ],
        }
      : {
          historyId: "103",
          nextPageToken: "next",
          history: [{ messagesAdded: [{ message: { id: "a" } }] }],
        },
  );
  assert.deepEqual(await changedMessages(client, "100"), {
    ids: ["a", "b"],
    cursor: "105",
  });
});
test("first poll establishes a baseline; failed message fetch preserves checkpoint", async (t) => {
  const h = harness();
  t.after(h.close);
  const client = new MailFake("eivind@theopenengine.com", (path) => {
    if (path.startsWith("history"))
      return {
        historyId: "102",
        history: [{ messagesAdded: [{ message: { id: "a" } }] }],
      };
    throw new ApiError("gmail", 503);
  });
  const source = sourceFixture(h, client);
  await source.poll();
  assert.equal(h.store.get("cursor:gmail-company"), "100");
  await assert.rejects(source.poll());
  assert.equal(h.store.get("cursor:gmail-company"), "100");
});
test("reply to private email sends through verified company mailbox without foreign Gmail thread ID", async (t) => {
  const h = harness();
  t.after(h.close);
  const privateClient = new MailFake("personal@example.com");
  const company = new MailFake("eivind@theopenengine.com");
  const source = sourceFixture(h, privateClient, company);
  const context = {
    source: source.id,
    thread: "private-thread",
    complete: true,
    gaps: [],
    messages: [await decodeMessage(rawMail(), source.id, [])],
  };
  const route = await source.route(context);
  assert.equal(route?.from, company.email);
  assert.equal(route?.thread, undefined);
  const proposal = await h.propose();
  await source.send({ ...proposal, route });
  const request = company.calls.find((call) => call.path === "messages/send")!;
  const body = request.body as { raw: string; threadId?: string };
  const parsed = await simpleParser(Buffer.from(body.raw, "base64url"));
  assert.equal(parsed.from?.value[0]?.address, company.email);
  assert.equal(
    parsed.to && !Array.isArray(parsed.to) ? parsed.to.value[0]?.address : "",
    "reply@example.com",
  );
  assert.equal(parsed.cc, undefined);
  assert.equal(parsed.bcc, undefined);
  assert.equal(body.threadId, undefined);
  assert.equal(parsed.inReplyTo, "<root@example.com>");
  assert.equal(
    privateClient.calls.some((call) => call.path === "messages/send"),
    false,
  );
});
test("expired Gmail history recovers messages without skipping the recovery window", async (t) => {
  const h = harness();
  t.after(h.close);
  h.store.ingest("gmail-company", [], "old-history", 1000);
  const client = new MailFake("eivind@theopenengine.com", (path) => {
    if (path.startsWith("history")) throw new ApiError("gmail", 404);
    if (path.startsWith("messages?"))
      return { messages: [{ id: "recovered" }] };
    return rawMail("recovered");
  });
  const source = sourceFixture(h, client);
  await source.poll();
  assert.equal(h.store.get("cursor:gmail-company"), "100");
  assert.equal(h.store.jobs(Date.now() + 20_000).length, 1);
});
test("company replies related to a private thread are included before triage", async (t) => {
  const h = harness();
  t.after(h.close);
  const privateClient = new MailFake("personal@example.com", (path) =>
    path.startsWith("threads/") ? { messages: [{ id: "mail1" }] } : rawMail(),
  );
  const reply = {
    ...rawMail("reply", ["SENT"]),
    threadId: "company-thread",
    internalDate: "2000",
    raw: Buffer.from(
      "From: eivind@theopenengine.com\r\nTo: alice@example.com\r\nSubject: Re: Project update\r\nMessage-ID: <reply@theopenengine.com>\r\nReferences: <root@example.com>\r\n\r\nAlready answered.",
    ).toString("base64url"),
  };
  const company = new MailFake("eivind@theopenengine.com", (path) =>
    path.startsWith("messages?") || path.startsWith("threads/")
      ? { messages: [{ id: "reply" }] }
      : reply,
  );
  const source = sourceFixture(h, privateClient, company);
  const context = await source.conversation("thread1");
  assert.equal(context.complete, true);
  assert.equal(context.messages.length, 2);
  assert.equal(context.messages.at(-1)?.outgoing, true);
});

function sourceFixture(
  h: ReturnType<typeof harness>,
  client: MailFake,
  company = client,
) {
  return new GmailSource(
    {
      id: client === company ? "company" : "private",
      email: client.email,
      client,
      sender: { id: "company", email: company.email, client: company },
      ownEmails: [client.email, company.email],
    },
    h.store,
  );
}
