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
`team_id` into the owner profile. The reviewed
native Slack MCP backend version is 1.3.0. Filter the reader to read/search tools;
route writes through `slack-actions` with the guarded wrapper and native prompts.
The watcher searches your DMs and mentions. Search indexing can delay detection.
Direct-message Telegram notices run independently of model triage once the watcher
is configured. A fresh incoming DM is needed for a real arrival-latency test.

## WhatsApp

Install your own [local WhatsApp bridge](https://github.com/lharries/whatsapp-mcp) and pair it through your phone's linked
devices UI. Store your international phone and private bridge-store directory in
the owner profile. Verify the linked device JID before enabling writes. Keep the
REST API bound to 127.0.0.1:8080; do not expose it on a public interface.

Use `whatsapp-read.mjs` as `whatsapp-structured`, with `messages`, `text`, `media`, `av` in
its tool filter. For a queued message, pass `chat_jid` and `message_id` to
`messages`; it returns chronological context and `older`/`newer` cursors. Continue
with the returned message ID and direction in the same chat when more relevant
context is needed. `limit` applies per side (15 by default). Read the latest chat
messages separately to check subsequent replies. Date/offset scans remain available
for periodic reconciliation, but cannot be combined with message-ID context.
Large message bodies have `content_complete: false`; finish them with the `text`
tool using the exact IDs, returned offset and content hash. Message pages may be
smaller than the requested limit; follow the returned cursors without assuming
a fixed page size.
The AV reader verifies hashes, transcribes speech locally and
returns video images in bounded chunks. Its Mac dependencies are FFmpeg/ffprobe
under /opt/homebrew/bin and a Python 3.12 environment at
`~/.local/share/secretary-runtime/media-venv`, installed from
`deploy/openclaw/media-requirements.txt`. The local Hugging Face cache must contain
mlx-community/whisper-large-v3-turbo. Linux needs a tested alternate backend.

When preparing the bridge, verify signed media URLs retain their query parameters
and cache filenames include message identity. Upstream/mirror versions can differ;
run a real download/hash check before claiming media reads work. Never acknowledge
an unread or failed source just to clear the queue.

Image readers (WhatsApp, Slack and Discord) re-encode every image with macOS `sips`
as an 8-bit JPEG no larger than 1600 pixels on its long edge, cached by source hash
under `~/.local/share/secretary-media`. A raw phone screenshot can take 100+ chunk
calls and still fail to render; the converted copy takes a few. Results keep the
original `source_sha256`. An attachment that can never be opened (unsupported type,
undecodable image, over the size limit) returns `readable: false` instead of an
error. That result is final, so the message can be marked read; retrying it would
only repeat the same failure on every check. Network, auth and local tool failures
stay errors and remain queued for retry.

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
blindly retried. Keep all those checks enabled when connecting a source.

## Authenticated GitHub reads

`deploy/openclaw/action-preview/github-read.mjs <private-settings.json>` exposes
one read-only MCP tool. Settings contain `ghPath` (absolute GitHub CLI path),
`login` (verified owner's GitHub login), and `allowedOwners` (repository owner
allowlist). It uses existing local GitHub CLI authentication, checks the account
on every call, and permits only fixed GET routes for PRs, files, comments, reviews
and CI evidence. Follow `next_page`; read source files at the PR head SHA.
Register it as `github-read` and allow `github-read__read`; approval mode `approve`
is appropriate only for this read-only server. No credentials belong in Git.

## Slack attachment reads

`deploy/openclaw/action-preview/slack-media.mjs <private-empty-settings.json>`
exposes `media` for exact Slack file IDs. The existing company user token needs
`files:read` in addition to its conversation scopes; adding the scope requires
reauthorizing the existing app. Supply the verified company token explicitly as
`SLACK_MCP_XOXP_TOKEN`, not an ambient token from another workspace. The reader
checks the configured owner/workspace, bounds downloads, rejects off-host
redirects, and provides immutable hashes, image chunks, and local audio/video
analysis. Register `slack-media__media` as read-only. Missing authorization leaves
attachments unread; never mark a blocked attachment as processed. Non-media files
and files over 100 MiB return `readable: false` without being downloaded.

## Discord server monitoring

Create an owner-controlled, dedicated Discord bot. Enable Message Content Intent;
server member and presence intents are unnecessary. Invite it to the intended server
with View Channels and Read Message History only. Check its effective role permissions
and channel overrides: inherited public permissions can still permit sends. Deny bot
Send Messages, Send Messages in Threads, Add Reactions, and Create Threads when the
server's everyone role grants them. No administrator or moderation permissions are
needed. The connector exposes GET operations only, even if server roles are broader.

Keep a mode-600 settings JSON outside Git containing tokenFile (a mode-600 bot-token
file), botId, guildId, ownerId, and channelIds. Identity checks require a bot account
and the configured application with Message Content enabled. Numeric source IDs must
come from the verified server. The reader additionally rejects other guilds/channels.
Register discord-read.mjs as discord-read using the reviewed Node 26 runtime (it
imports the shared TypeScript API through native type stripping). Allow only
read and media as read-only MCP tools. No inbound Discord channel is needed: owner
instructions and notifications remain on Telegram.

Add discord: {settingsFile, startAt} to the private watcher config. Pick an explicit
backfill start time. It polls every 30 seconds, includes active and public archived
threads/forum posts, skips join events and the bot's own messages, and preserves
checkpoints on any failed scan. Old message edits are not a separate event stream;
source-backed tasks are re-read during reconciliation. Private archived threads and
personal DMs are outside this setup. Rate-limit responses establish a shared local
cooldown before further API reads. Keep only one watcher active.

Media downloads use the exact attachment from an authenticated message, preserve its
signed CDN query, restrict the host/path, send no bot token to the CDN, bound bytes,
and verify size/hash. Images and AV use the same full-chunk/window protocol as Slack;
small UTF-8 text/log/JSON attachments are read directly. Other attachments return
`readable: false`.

After real channel/thread/attachment reads pass, enable the watcher and verify durable
queue acknowledgement. A daily cron system-event wake containing DISCORD_DAILY_DIGEST
can flush low-priority items at the owner's chosen local time (default 18:00). Check
existing jobs to avoid duplicate schedules. Urgent feedback is independent of this
schedule; public replies remain drafts for exact owner approval.
