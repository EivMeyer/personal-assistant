import test from "node:test";
import assert from "node:assert/strict";
import { googleReadRequest, googleTools } from "./google-read.mjs";
import { verifyCompany } from "./google-auth.mjs";

test("company identity is mandatory and no write tools exist", () => {
  verifyCompany({ email: "owner@theopenengine.com", email_verified: true });
  for (const p of [
    { email: "personal@example.com", email_verified: true },
    { email: "owner@theopenengine.com", email_verified: false },
  ])
    assert.throws(() => verifyCompany(p), /identity/);
  assert.ok(googleTools.every((t) => t.annotations.readOnlyHint));
  assert.throws(() => googleReadRequest("delete", { fileId: "a" }), /Unknown/);
  assert.throws(() =>
    googleReadRequest("file", { fileId: "a", method: "DELETE" }),
  );
});
test("calendar windows require offsets and preserve recurrence, IDs and pagination", () => {
  const a = {
    calendarId: "a/b@example.com",
    timeMin: "2026-10-22T00:00:00+02:00",
    timeMax: "2026-10-23T00:00:00+02:00",
    pageToken: "opaque/+",
  };
  const r = googleReadRequest("events", a);
  assert.equal(r.url.origin, "https://www.googleapis.com");
  assert.match(r.url.pathname, /a%2Fb%40example.com/);
  assert.equal(r.url.searchParams.get("singleEvents"), "true");
  assert.equal(r.url.searchParams.get("pageToken"), "opaque/+");
  assert.throws(
    () => googleReadRequest("events", { ...a, timeMax: a.timeMin }),
    /follow/,
  );
  assert.throws(() =>
    googleReadRequest("events", { ...a, timeMin: "2026-10-22T00:00:00" }),
  );
});
test("shared drive requests remain paginated and only free-busy uses POST", () => {
  const r = googleReadRequest("files", {
    driveId: "shared",
    pageToken: "next",
  });
  assert.equal(r.url.searchParams.get("corpora"), "drive");
  assert.match(r.url.searchParams.get("fields"), /incompleteSearch/);
  assert.equal(r.url.searchParams.get("pageToken"), "next");
  const b = googleReadRequest("availability", {
    calendarIds: ["primary"],
    timeMin: "2026-10-22T00:00:00Z",
    timeMax: "2026-10-23T00:00:00Z",
  });
  assert.equal(b.method, "POST");
  assert.deepEqual(JSON.parse(b.body).items, [{ id: "primary" }]);
});
