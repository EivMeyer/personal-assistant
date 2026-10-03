# Recreate the assistant setup

This is Eivind's personal OpenClaw setup: Telegram is the interface, connected
accounts supply context, and external actions require a preview and approval.
The repository contains code and templates. It does not contain an account,
credentials, chat history, personal memory or a preconnected assistant.

Start with Telegram and one read-only source. Add other accounts after that works.
This is a maintained personal setup, not a one-command installer. The tested host
is an Apple Silicon Mac; local audio/video processing and LaunchAgents are Mac
specific. Text connectors can be adapted to another host, but that deployment has
not been verified here.

## 1. Install the runtime and checkout

Use Node 26.1 or newer in the Node 26 line for OpenClaw 2026.9.6. Use the same Node
binary for `npm ci`, the watcher and its native SQLite dependency. OpenClaw also
supports Node 24.16 or newer in the Node 24 line. The repository's tests run on
Node 22, but Node 22 cannot run this OpenClaw version.

```sh
npm install -g openclaw@2026.9.6
git clone https://github.com/EivMeyer/personal-assistant.git
cd personal-assistant
npm ci
npm run check
openclaw onboard
```

In OpenClaw onboarding, authenticate your own model account and use a local,
loopback-only gateway. This setup uses the Codex harness, GPT-6 Astra and high
reasoning. Confirm that your account can access that model. If it cannot, choose
and test your own supported model explicitly; copying a model name grants no
access. Use the Codex binary bundled with the reviewed OpenClaw Codex plugin,
not an independently updating Homebrew override.

Do not copy Eivind's runtime folders or authentication files. If you already run
OpenClaw, back up its configuration and merge the settings below. Do not replace
an existing workspace, token, allowlist or connector configuration wholesale.

## 2. Create your owner profile and Telegram bot

Create your own bot with Telegram's BotFather. Save the token privately at
`~/.openclaw/telegram-token`, with permissions `600`; do not put it in a shell
command, Git or an AI conversation. Message your bot once, then obtain your
numeric Telegram user ID from OpenClaw's inbound/pairing diagnostics. A username
or the bot's numeric ID is not your owner ID.

```sh
umask 077
mkdir -p ~/.local/share/secretary ~/.local/share/secretary-actions
mkdir -p ~/.local/share/secretary-context ~/.local/share/secretary-watch
mkdir -p ~/.openclaw/workspace
```

Create `~/.local/share/secretary/profile.json` and replace every example value:

```json
{
  "name": "Your name",
  "workEmail": "you@example.com",
  "telegramUserId": "123456789",
  "timezone": "Europe/Berlin"
}
```

Use your actual sending account for `workEmail`, even if it is not a company
account. Every email action verifies that exact account; a separately connected
personal inbox remains read-only. Optional WhatsApp and Slack identity fields
are documented in [OpenClaw integration](openclaw.md).

Set permissions on the files after saving them:

```sh
chmod 600 ~/.local/share/secretary/profile.json ~/.openclaw/telegram-token
```

## 3. Initialize local state and install the plugin

From the checkout, initialize an empty durable inbox database. This command does
not connect any inbox or send anything:

```sh
node --input-type=module -e 'import { WatchStore } from "./dist/openclaw/watch-store.js"; import { homedir } from "node:os"; const s = new WatchStore(homedir()+"/.local/share/secretary-watch/watch.sqlite"); s.db.close();'
openclaw plugins install --link ./deploy/openclaw/action-preview --force --accept-capabilities
```

Review the checkout before running the install command: `--force` acknowledges
this local source and `--accept-capabilities` accepts its declared capabilities.
It needs
conversation access for the private review queue and prompt hooks for the monitor.

Copy the files from `deploy/openclaw/workspace/` into your new workspace. Replace
`{{name}}` and `{{workEmail}}` with your profile values, and adapt the company name,
website, priorities and writing preferences to your own context. Preserve the
owner verification, untrusted-source and exact-action approval rules. Do not
copy another person's USER.md, MEMORY.md, TASKS.md or inbox-state.json.

Create an empty `TASKS.md` and an `inbox-state.json` containing `{"sources":{}}`.
The watcher creates source checkpoints from your chosen start time.

In `~/.openclaw/openclaw.json`, merge these settings using your actual owner ID and
absolute paths. These are partial settings, not a complete replacement config:

```json
{
  "gateway": { "mode": "local", "bind": "loopback", "port": 18789 },
  "agents": {
    "defaults": {
      "workspace": "/absolute/path/to/.openclaw/workspace",
      "model": { "primary": "openai/gpt-6-astra", "fallbacks": [] },
      "models": { "openai/gpt-6-astra": { "agentRuntime": { "id": "codex" } } },
      "thinkingDefault": "high"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "tokenFile": "/absolute/path/to/.openclaw/telegram-token",
      "dmPolicy": "allowlist",
      "allowFrom": ["123456789"],
      "defaultTo": "123456789",
      "groupPolicy": "disabled",
      "execApprovals": {
        "enabled": true,
        "approvers": ["123456789"],
        "target": "dm"
      },
      "capabilities": { "inlineButtons": "dm" }
    }
  },
  "plugins": {
    "entries": {
      "secretary-action-preview": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        }
      }
    }
  },
  "tools": {
    "profile": "full",
    "fs": { "workspaceOnly": true },
    "allow": [
      "read",
      "write",
      "edit",
      "apply_patch",
      "memory_search",
      "memory_get",
      "session_status",
      "cron",
      "secretary_review",
      "secretary_gmail_read"
    ],
    "deny": [
      "exec",
      "process",
      "browser",
      "gateway",
      "nodes",
      "canvas",
      "sessions_spawn",
      "sessions_send",
      "agents_list",
      "view_image",
      "tts",
      "message"
    ]
  }
}
```

Keep the gateway authentication generated by onboarding. Start with no external
write tools. Add reader names to the finite allowlist only when you configure and
verify those connectors. Plugin installation manages its load path; keep that
pointing at this checkout.

## 4. Apply the reviewed runtime patches

The patches fail closed on unreviewed runtime versions. For a global npm install:

```sh
OPENCLAW_PACKAGE="$(npm root -g)/openclaw"
node deploy/openclaw/action-preview/silent-turn-patch.mjs "$OPENCLAW_PACKAGE"
node deploy/openclaw/action-preview/package-install-patch.mjs "$OPENCLAW_PACKAGE"
node deploy/openclaw/action-preview/telegram-menu-patch.mjs "$OPENCLAW_PACKAGE"
node deploy/openclaw/action-preview/telegram-approval-patch.mjs "$OPENCLAW_PACKAGE"
node deploy/openclaw/action-preview/cron-history-patch.mjs "$OPENCLAW_PACKAGE"
node deploy/openclaw/action-preview/heartbeat-resume-patch.mjs "$OPENCLAW_PACKAGE"
```

The Codex bounded-turn patch in `runtime-patch.mjs` targets the separately
installed `@openclaw/codex` package. Inspect its installed path/version first;
run `node deploy/openclaw/action-preview/runtime-patch.mjs /absolute/path/to/@openclaw/codex`
only when reproducing the same Astra/high configuration. Do not guess package paths
or apply patches to a different version. Reapply reviewed patches after reinstalling
the runtime; the heartbeat patch links back to this checkout.

```sh
openclaw config validate
npm run doctor
openclaw gateway restart --safe
openclaw health --json
```

Send a message to your Telegram bot and confirm a reply. A green health response
only proves runtime/transport health, not that inbox reads or external sends work.

## 5. Connect your accounts

Follow [Connect one account at a time](connectors.md):

- Gmail: your own Google OAuth client and separate credentials per mailbox.
- Calendar/Docs: run the included Google setup flow; verify the actual account.
- WhatsApp: pair your own local bridge through Linked Devices. Keep its REST API
  on `127.0.0.1:8080`; verify your device identity. Read-only text tools are
  `messages` and `text`; add `media` and `av` only with their local dependencies.
- Slack: your own authorized workspace user token, verified user/team IDs, and
  `files:read` if you want attachments.
- GitHub: authenticated `gh` with your own login and an explicit owner allowlist.
- Discord: a dedicated bot with effective read-only channel permissions.

For each source, read one real conversation completely before enabling monitoring.
Media support needs separate verification. Never clear unread messages to make a
queue look healthy.

External writes must use a separate guarded connector and native
`codex.defaultToolsApprovalMode: "prompt"`. The preview shows the exact action;
approval applies once, source freshness is rechecked, and a receipt confirms the
outcome. Do not grant permanent approval or expose an unguarded alternative.
Test one harmless action only with your own explicit approval, then verify it at
the destination. See [the verification checklist](verification.md).

## 6. Enable background monitoring

Copy [watcher.example.json](../deploy/openclaw/watcher.example.json) to
`~/.local/share/secretary-watch/config.json`, replacing all paths and the start time.
It starts with WhatsApp only; `gmail: []` needs no Google credentials and the
unused `oauthKeys` path is not read. Use `src/openclaw/watch.ts` and
[the watcher instructions](connectors.md#background-watcher-and-action-gate).
Choose `startAt` explicitly, usually now, so the first run does not ingest years
of history. Configure the local wake hook with its own private random token in OpenClaw's
`hooks.token` and the same token in the watcher's `wakeTokenFile` (mode 600).
Use `hooks.enabled: true`, `hooks.path: "/hooks"`,
`hooks.allowedAgentIds: ["main"]` and `hooks.allowRequestSessionKey: false`.
Keep this token local; it authorizes wake requests, not external actions. Run the
compiled watcher with that config:

```sh
node dist/openclaw/watch.js ~/.local/share/secretary-watch/config.json
```

Verify `incoming_detected` and a completed
queue acknowledgement before installing its LaunchAgent.

Use `deploy/openclaw/com.theopenengine.secretary-watch.plist.example`; replace
`{{HOME}}` and `{{REPO}}`, and verify every executable path. Use the Node binary
that built `better-sqlite3`. The recovery LaunchAgent is optional and expects an
`~/.local/bin/openclaw` wrapper. Do not enable it until that wrapper works.

Then enable the main agent's heartbeat with `every: "5m"`, `timeoutSeconds: 240`,
`isolatedSession: true`, `model: "openai/gpt-6-astra"`, and your Telegram delivery
target. In `openclaw cron list --json`, find `heartbeat-main`, and install the
monitor policy as its scratch content:

```sh
openclaw cron scratch YOUR_HEARTBEAT_JOB_ID --file deploy/openclaw/workspace/HEARTBEAT.md
```

The plugin supplies fresh queue IDs and bounded instructions for every background
turn. It defers checks during network outages and after host suspension; unread
work stays queued. This does not make a sleeping Mac an always-on server. The
optional awake LaunchAgent prevents idle system sleep on AC, not lid closure or
explicit sleep. Server deployment requires a separately verified migration.

## Troubleshooting

- `No such module` or SQLite ABI mismatch: use the intended Node version and rerun
  `npm ci` in the checkout; do not share native `node_modules` across runtimes.
- Owner profile or sender mismatch: fix the profile/account binding. Do not remove
  the identity check.
- Plugin load failure: run `openclaw plugins doctor`, check private directories,
  the owner profile and the checkout's dependencies.
- Telegram connects but background work fails: inspect `openclaw cron runs`, the
  gateway log and watcher log. Health alone is insufficient.
- Large reads: follow returned text/content cursors with their hashes. Never
  treat truncated JSON or a partial email body as a complete conversation.
- Upgrade: retain private state, read the new runtime's changes, rerun tests and
  revalidate the patches before restarting. Do not blindly upgrade to latest.
