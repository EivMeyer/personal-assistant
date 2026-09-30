# Connect one account at a time

Every installation has its own owner profile, credentials and databases. Begin
with reads. After authentication, verify the actual account identity, read a full
conversation, and only then prepare an action test. Never enable every connector
because its name appears in a template.

## Google Calendar and Docs

Create a private settings JSON with `clientPath` pointing to an installed-app
OAuth client and `tokenPath` pointing to a new local token file. Run:

```sh
node deploy/openclaw/action-preview/google-setup.mjs /absolute/private/settings.json
```

The local flow uses PKCE/state and verifies your configured company email. Enable
Calendar, Drive and Docs APIs in your OAuth project. The company reader entrypoint
is `google-read.mjs`; pass the settings path as its argument. Register it as
`google-work`, filter to `calendars`, `events`, `event`, `availability`, `files`,
`file`, `document`, `export_text`, and add `google-work__*` to the finite allowlist.
Use the isolated runtime Node binary for the active MCP server.

For writes create separate settings with `mode: "actions"` and a separate token.
Run the same setup flow. Register `google-work-actions` through guarded-mcp.mjs,
with private backend configuration invoking google-actions.mjs and those settings.
Require native `codex.defaultToolsApprovalMode: "prompt"`. Supported writes are
calendar create/update/RSVP/cancel and document create/edit. No sharing, arbitrary
file deletion, recurring-series mutation or personal-calendar fallback is exposed.
See the backend protocol and schemas in action-preview before generating config.

## Gmail

Use separate owner-authorized company and optional personal credentials. The
company Gmail sender must match `workEmail`; personal Gmail stays read-only.
The watcher accepts OAuth client/credential file paths in its private config.
Use a read-only Gmail MCP tool filter; route writes through a distinct
`gmail-work-actions` guarded connector. Verify the actual Gmail profile, not just
an OAuth login hint. Read full threads and attachments relevant to the request.

## Slack

Obtain your own workspace user token through the approved Slack app installation.
Keep it in a private environment file. Verify `auth.test`; copy its `user_id` and
`team_id` into your owner profile. Do not copy another person's IDs. The reviewed
native Slack MCP backend version is 1.3.0. Filter the reader to read/search tools;
route writes through `slack-actions` with the guarded wrapper and native prompts.
The watcher searches your DMs and mentions. Search indexing can delay detection.
Direct-message Telegram notices run independently of model triage once the watcher
is configured. A fresh incoming DM is needed for a real arrival-latency test.

## WhatsApp

Install your own local WhatsApp bridge and pair it through your phone's linked
devices UI. Store your international phone and private bridge-store directory in
the owner profile. Verify the linked device JID before enabling writes. Keep the
REST API bound to 127.0.0.1:8080; do not expose it on a public interface.

Use `whatsapp-read.mjs` as `whatsapp-structured`, with `messages`, `media`, `av` in
its tool filter. The AV reader verifies hashes, transcribes speech locally and
returns video images in bounded chunks. Its Mac dependencies are FFmpeg/ffprobe
under /opt/homebrew/bin and a Python 3.12 environment at
`~/.local/share/secretary-runtime/media-venv`, installed from
`deploy/openclaw/media-requirements.txt`. The local Hugging Face cache must contain
mlx-community/whisper-large-v3-turbo. Linux needs a tested alternate backend.

When preparing the bridge, verify signed media URLs retain their query parameters
and cache filenames include message identity. Upstream/mirror versions can differ;
run a real download/hash check before claiming media reads work. Never acknowledge
an unread or failed source just to clear the queue.

## Background watcher and action gate

The watcher entrypoint is `dist/openclaw/watch.js`; its config schema lives in
src/openclaw/watch.ts. Use a private database under ~/.local/share/secretary-watch,
an explicit startAt, independent Gmail accounts, your verified Slack binding,
and your paired WhatsApp database. Set wakeUrl to http://127.0.0.1:18789/hooks/wake
and keep the hook token in a private file. Render LaunchAgent templates by replacing
{{HOME}} and {{REPO}} with your actual absolute paths. Use the same Node version
as npm ci for the native SQLite addon. Do not launch the legacy daemon.

The guarded wrapper reads backend definitions from a private configuration file;
inspect guarded-mcp.mjs's CLI contract when wiring a connector. The action-preview
plugin verifies owner ingress and sender identity, binds the exact argument preview,
and reserves a single-use action before backend execution. After approval it
refreshes source snapshots and target versions. Unknown send outcomes are never
blindly retried. Keep all those checks enabled during onboarding.
