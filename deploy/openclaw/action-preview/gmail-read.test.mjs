import test from "node:test";
import assert from "node:assert/strict";
import { gmailTextPage } from "./gmail-read.mjs";
import { profileSchema } from "./owner-profile.mjs";
test("HTML-only mail is decoded completely and long text is hash-paginated", async () => {
  const text = "Receipt detail ".repeat(10000);
  const mime =
    "From: billing@example.com\r\nTo: owner@example.net\r\nSubject: Receipt\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>" +
    text +
    '</p><a href="https://example.com/receipt">Receipt link</a></body></html>';
  const raw = {
    id: "abc123",
    threadId: "def456",
    raw: Buffer.from(mime).toString("base64url"),
  };
  let offset = 0,
    sha,
    joined = "",
    count = 0;
  do {
    const page = await gmailTextPage(raw, { offset, expected_sha256: sha });
    assert.ok(JSON.stringify(page).length < 48000);
    joined += page.text;
    offset = page.next_offset;
    sha = page.sha256;
    count++;
  } while (offset !== null);
  const decoded = JSON.parse(joined);
  assert.equal((decoded.text.match(/Receipt detail/g) || []).length, 10000);
  assert.match(decoded.text, /https:\/\/example.com\/receipt/);
  assert.ok(count > 1);
  await assert.rejects(gmailTextPage(raw, { offset: 1 }), /expected_sha256/);
  await assert.rejects(
    gmailTextPage(
      { ...raw, raw: Buffer.from(mime + "changed").toString("base64url") },
      { offset: 0, expected_sha256: sha },
    ),
    /changed/,
  );
});
test("each installation can bind its own valid work email", () => {
  const profile = profileSchema.parse({
    name: "Test Owner",
    workEmail: "owner@example.net",
    telegramUserId: "123456789",
    timezone: "Europe/Oslo",
  });
  assert.equal(profile.workEmail, "owner@example.net");
});
