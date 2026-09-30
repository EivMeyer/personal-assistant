import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callGoogleAction } from "./google-actions.mjs";
import { parseGoogleAction } from "./google-action-schema.mjs";
import { planPreview } from "./index.mjs";
import { sourceRefs } from "./source-snapshot.mjs";
import { executeGuarded, ActionStore } from "./action-guard.mjs";
const company = "owner@theopenengine.com";
const event = {
  id: "event-1",
  etag: '"v1"',
  summary: "Fixture meeting",
  organizer: { email: company, self: true },
  attendees: [
    { email: company, self: true },
    { email: "guest@example.invalid" },
  ],
};
const existing = {
  eventId: event.id,
  expectedEtag: event.etag,
  expectedSummary: event.summary,
  expectedOrganizer: company,
  expectedAttendees: event.attendees.map((a) => a.email),
};
const details = {
  summary: "Corrected meeting",
  description: "Exact approved text",
  location: "Oslo",
  start: "2026-10-22T10:00:00+02:00",
  end: "2026-10-22T10:30:00+02:00",
};
const docArgs = {
  documentId: "doc-1",
  expectedRevisionId: "r1",
  expectedTitle: "Fixture document",
  acknowledgeShared: true,
  tabId: "tab-1",
  edit: {
    kind: "replace",
    find: "old",
    replacement: "new",
    expectedOccurrences: 2,
  },
};
const doc = {
  revisionId: "r1",
  tabs: [
    {
      tabProperties: { tabId: "tab-1" },
      documentTab: {
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: "old and old\n" } }],
              },
            },
          ],
        },
      },
    },
  ],
};
function fixtureRead(url, options) {
  if (url.includes("/calendar/")) return Response.json(options.event ?? event);
  if (url.includes("/drive/"))
    return Response.json({
      name: "Fixture document",
      mimeType: "application/vnd.google-apps.document",
      capabilities: { canEdit: true },
      shared: true,
    });
  return Response.json(options.doc ?? doc);
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "google-actions-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = {
    clientPath: join(dir, "client.json"),
    tokenPath: join(dir, "token.json"),
  };
  await writeFile(
    settings.clientPath,
    JSON.stringify({
      installed: { client_id: "fixture", client_secret: "fixture" },
    }),
  );
  await writeFile(
    settings.tokenPath,
    JSON.stringify({ email: company, refresh_token: "fixture" }),
  );
  const calls = [];
  const request = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/token"))
      return Response.json({ access_token: "fixture" });
    if (url.endsWith("/userinfo"))
      return Response.json({
        email: options.email ?? company,
        email_verified: true,
      });
    if (!init.method || init.method === "GET") return fixtureRead(url, options);
    calls.push({ url, ...init });
    if (options.networkError) throw Error("fixture lost response");
    if (init.method === "DELETE" && !options.status)
      return new Response(null, { status: 204 });
    return Response.json(
      { id: "created-fixture", replies: [] },
      { status: options.status ?? 200 },
    );
  };
  return { settings, request, calls };
}
test("all calendar actions use company primary, exact recipients and conditional writes", async (t) => {
  const f = await fixture(t);
  for (const [name, args] of [
    ["calendar_create", { ...details, attendees: ["guest@example.invalid"] }],
    ["calendar_update", { ...existing, ...details }],
    ["calendar_rsvp", { ...existing, response: "accepted" }],
    ["calendar_cancel", existing],
  ])
    assert.notEqual(
      (await callGoogleAction(name, args, f.settings, f.request)).isError,
      true,
    );
  assert.equal(f.calls.length, 4);
  for (const call of f.calls)
    assert.match(call.url, /calendars\/primary\/events.*sendUpdates=all/);
  assert.deepEqual(JSON.parse(f.calls[0].body).attendees, [
    { email: "guest@example.invalid" },
  ]);
  assert.equal(f.calls[1].headers["If-Match"], event.etag);
  assert.equal(JSON.parse(f.calls[1].body).attendees, undefined);
  assert.deepEqual(JSON.parse(f.calls[2].body), {
    attendeesOmitted: true,
    attendees: [{ email: company, responseStatus: "accepted" }],
  });
  assert.equal(f.calls[3].method, "DELETE");
});
test("wrong identity, stale versions, changed guests and recurring series never dispatch", async (t) => {
  const cases = [
    { email: "private@example.invalid" },
    { event: { ...event, etag: '"v2"' } },
    { event: { ...event, attendees: [] } },
    { event: { ...event, recurrence: ["RRULE:FREQ=DAILY"] } },
    {
      event: {
        ...event,
        organizer: { email: "other@example.invalid", self: false },
      },
    },
  ];
  for (const options of cases) {
    const f = await fixture(t, options);
    assert.equal(
      (
        await callGoogleAction(
          "calendar_cancel",
          existing,
          f.settings,
          f.request,
        )
      ).isError,
      true,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("document creation is one private upload; edits bind tab, literal text and revision", async (t) => {
  const f = await fixture(t);
  await callGoogleAction(
    "document_create",
    { title: "Private fixture", text: "Exact text" },
    f.settings,
    f.request,
  );
  const created = f.calls[0];
  assert.match(created.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(created.body, /"parents":\["root"\]/);
  assert.equal(
    new URL(created.url).searchParams.get("ignoreDefaultVisibility"),
    "true",
  );
  assert.match(created.body, /Exact text/);
  assert.doesNotMatch(created.body, /permissions/);
  await callGoogleAction("document_edit", docArgs, f.settings, f.request);
  const body = JSON.parse(f.calls[1].body);
  assert.deepEqual(body.writeControl, { requiredRevisionId: "r1" });
  assert.deepEqual(body.requests[0].replaceAllText.tabsCriteria, {
    tabIds: ["tab-1"],
  });
  assert.equal(body.requests[0].replaceAllText.containsText.matchCase, true);
  await callGoogleAction(
    "document_edit",
    { ...docArgs, edit: { kind: "append", text: "Added text" } },
    f.settings,
    f.request,
  );
  assert.equal(
    JSON.parse(f.calls[2].body).requests[0].insertText.endOfSegmentLocation
      .tabId,
    "tab-1",
  );
});
test("stale document, missing tab, mismatch count and undisclosed shared edit fail before mutation", async (t) => {
  const cases = [
    { args: docArgs, doc: { ...doc, revisionId: "r2" } },
    { args: { ...docArgs, tabId: "wrong" } },
    { args: { ...docArgs, acknowledgeShared: false } },
    { args: { ...docArgs, edit: { ...docArgs.edit, expectedOccurrences: 1 } } },
  ];
  for (const item of cases) {
    const f = await fixture(t, { doc: item.doc });
    const result = await callGoogleAction(
      "document_edit",
      item.args,
      f.settings,
      f.request,
    );
    assert.equal(result.isError, true);
    assert.equal(f.calls.length, 0);
  }
});
test("API rejects are failures; network loss and server errors remain uncertain without retry", async (t) => {
  for (const status of [400, 401, 403, 409, 412, 429]) {
    const f = await fixture(t, { status });
    assert.equal(
      (
        await callGoogleAction(
          "calendar_cancel",
          existing,
          f.settings,
          f.request,
        )
      ).isError,
      true,
    );
    assert.equal(f.calls.length, 1);
  }
  for (const options of [{ status: 503 }, { networkError: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(
      callGoogleAction("calendar_cancel", existing, f.settings, f.request),
    );
    assert.equal(f.calls.length, 1);
  }
});
test("Google actions require owner, wrapper and native prompt; preview includes recipients", () => {
  const ctx = {
    requester: {
      channel: "telegram",
      senderId: "700000001",
      senderIsOwner: true,
    },
  };
  const config = {
    mcp: {
      servers: {
        "google-work-actions": {
          args: ["/repo/guarded-mcp.mjs"],
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      },
    },
  };
  const call = {
    toolName: "mcp__google-work-actions__calendar_cancel",
    params: { ...existing, secretary_sources: [], timeoutMs: 210000 },
  };
  const preview = planPreview(call, ctx, config);
  assert.match(preview.chunks.join(""), /guest@example.invalid/);
  assert.match(preview.chunks.join(""), /owner@theopenengine.com/);
  assert.throws(() => planPreview(call, {}, config), /Telegram owner/);
  config.mcp.servers["google-work-actions"].codex.defaultToolsApprovalMode =
    "approve";
  assert.throws(() => planPreview(call, ctx, config), /native approval/);
});
test("Google target freshness includes event, proposed window and cross-source conversations", () => {
  const refs = sourceRefs("google-work-actions", {
    ...existing,
    ...details,
    secretary_sources: [{ source: "gmail-work", thread: "thread-1" }],
  });
  assert.deepEqual(
    refs.map((r) => r.source),
    ["gmail-work", "google-event", "google-window"],
  );
  assert.deepEqual(
    sourceRefs("google-work-actions", { ...docArgs, secretary_sources: [] }),
    [{ source: "google-document", thread: "doc-1" }],
  );
  assert.throws(() =>
    parseGoogleAction("calendar_create", {
      ...details,
      attendees: [],
      organizer: "private@example.invalid",
    }),
  );
  assert.throws(() =>
    parseGoogleAction("calendar_create", {
      ...details,
      attendees: [],
      end: details.start,
    }),
  );
});
test("approved Google backend dispatch is single-use and durable, including uncertain writes", async (t) => {
  for (const networkError of [false, true]) {
    const f = await fixture(t, { networkError });
    const store = new ActionStore(":memory:");
    t.after(() => store.close());
    const args = { ...existing, secretary_sources: [], timeoutMs: 210000 };
    store.reserve({
      server: "google-work-actions",
      name: "calendar_cancel",
      args,
      snapshot: [],
      runId: "google-test",
    });
    const options = {
      server: "google-work-actions",
      name: "calendar_cancel",
      args,
      store,
      config: {},
      snapshot: async () => [],
      invoke: (name, args) =>
        callGoogleAction(name, args, f.settings, f.request),
    };
    await executeGuarded(options);
    await assert.rejects(executeGuarded(options), /consumed/);
    assert.equal(f.calls.length, 1);
    assert.equal(
      store.receipts()[0].state,
      networkError ? "unknown" : "completed",
    );
  }
});
