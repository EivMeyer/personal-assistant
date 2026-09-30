import test from "node:test";
import assert from "node:assert/strict";
import { stableGmailPayload } from "./source-snapshot.mjs";
import { digest } from "./action-store.mjs";

test("Gmail rotating attachment download handles do not invalidate unchanged context", () => {
  const make = (handle) => ({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: "original" } },
      { filename: "terms.pdf", body: { size: 123, attachmentId: handle } },
    ],
  });
  const a = make("opaque-first"),
    b = make("opaque-second");
  assert.equal(digest(stableGmailPayload(a)), digest(stableGmailPayload(b)));
  assert.equal(a.parts[1].body.attachmentId, "opaque-first");
  for (const change of [
    (p) => {
      p.parts[0].body.data = "changed";
    },
    (p) => {
      p.parts[1].filename = "changed.pdf";
    },
    (p) => {
      p.parts[1].body.size = 124;
    },
    (p) => {
      p.parts.pop();
    },
  ]) {
    const updated = make("opaque-first");
    change(updated);
    assert.notEqual(
      digest(stableGmailPayload(a)),
      digest(stableGmailPayload(updated)),
    );
  }
});
