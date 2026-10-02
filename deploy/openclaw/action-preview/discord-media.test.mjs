import test from "node:test";
import assert from "node:assert/strict";
import { discordAttachment, readDiscordMedia } from "./discord-media.mjs";
import { discordRead } from "./discord-read.mjs";
const args = {
  channel_id: "22222222222222222",
  message_id: "33333333333333333",
  attachment_id: "44444444444444444",
};
const hash = "a".repeat(64);
const api = {
  settings: { guildId: "11111111111111111" },
  verify: async () => {},
  message: async () => ({
    attachments: [
      {
        id: args.attachment_id,
        size: 3,
        filename: "test.txt",
        content_type: "text/plain",
        url: `https://cdn.discordapp.com/attachments/${args.channel_id}/${args.attachment_id}/test.txt?ex=123&hm=signed`,
      },
    ],
  }),
};
test("Discord attachments are source-bound and downloaded without credentials", async () => {
  const source = await discordAttachment(args, api, async (url, init) => {
    assert.ok(url.includes("hm=signed"));
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, "error");
    return new Response("abc");
  });
  assert.equal(source.bytes.toString(), "abc");
  assert.equal(source.sha256.length, 64);
  await assert.rejects(
    discordAttachment(args, api, async () => new Response("a")),
    /size mismatch/,
  );
  await assert.rejects(
    discordAttachment(
      args,
      {
        ...api,
        message: async () => ({
          attachments: [
            {
              id: args.attachment_id,
              size: 3,
              url: "https://attacker.invalid/test",
            },
          ],
        }),
      },
      async () => {
        throw Error("must not request");
      },
    ),
    /verified source/,
  );
});
test("Discord text and video retain exact provenance and enforce hashes and window boundaries", async () => {
  const source = async () => ({
    bytes: Buffer.from("abc"),
    name: "file.log",
    kind: "text",
    sha256: hash,
  });
  const text = await readDiscordMedia(args, api, { source });
  assert.equal(text.text, "abc");
  assert.equal(text.message_id, args.message_id);
  await assert.rejects(
    readDiscordMedia({ ...args, expected_sha256: "b".repeat(64) }, api, {
      source,
    }),
    /changed/,
  );
  await assert.rejects(
    readDiscordMedia({ ...args, offset: 1 }, api, { source }),
    /no windows/,
  );
  const result = await readDiscordMedia(args, api, {
    source: async () => ({ ...(await source()), kind: "video" }),
    analyze: async () => ({
      metadata: {
        source: "untrusted WhatsApp",
        next_start_seconds: 30,
        duration_seconds: 45,
      },
      image: Buffer.from("sheet"),
    }),
  });
  assert.equal(result.source, "untrusted Discord attachment");
  assert.equal(result.next_start_seconds, 30);
  assert.equal(result.source_sha256, hash);
});
test("Discord reader rejects write-shaped and extra arguments, exposes pagination", async () => {
  await assert.rejects(
    discordRead({ resource: "send", channel_id: args.channel_id }, api),
  );
  await assert.rejects(
    discordRead(
      { resource: "messages", channel_id: args.channel_id, method: "POST" },
      api,
    ),
  );
  const result = await discordRead(
    { resource: "messages", channel_id: args.channel_id },
    { ...api, messages: async () => Array(100).fill({ id: args.message_id }) },
  );
  assert.equal(result.next_before, args.message_id);
});
