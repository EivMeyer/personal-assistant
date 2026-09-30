import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlackMessages } from "./slack-source.mjs";
import { digest } from "./action-store.mjs";
const message = {
  ts: "123.456",
  user: "owner",
  text: "original",
  blocks: [
    {
      type: "rich_text",
      block_id: "generated-1",
      elements: [{ type: "text", text: "original" }],
    },
  ],
  files: [{ id: "F1", title: "original" }],
  reply_count: 0,
};
const hash = (messages) => digest(normalizeSlackMessages(messages));
test("regenerated Slack display IDs do not invalidate an unchanged approval", () => {
  const next = structuredClone(message);
  next.blocks[0].block_id = "generated-2";
  assert.equal(hash([message]), hash([next]));
  assert.equal(message.blocks[0].block_id, "generated-1");
});
test("real Slack text, rich content, files, identity, edits and replies still invalidate approval", () => {
  const mutations = [
    (m) => {
      m.text = "changed";
    },
    (m) => {
      m.blocks[0].elements[0].text = "changed";
    },
    (m) => {
      m.files[0].title = "changed";
    },
    (m) => {
      m.user = "other";
    },
    (m) => {
      m.edited = { ts: "124.0" };
    },
    (m) => {
      m.reply_count = 1;
    },
  ];
  for (const mutate of mutations) {
    const next = structuredClone(message);
    mutate(next);
    assert.notEqual(hash([message]), hash([next]));
  }
  assert.notEqual(
    hash([message]),
    hash([message, { ts: "new", text: "reply" }]),
  );
});
