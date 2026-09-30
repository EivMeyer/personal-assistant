# Your own assistant

Use a separate macOS login/machine and your own Telegram bot, model login and
source accounts. Never copy another person's `.openclaw` or `.local/share/secretary*`.
The shared runtime identity comes from your private owner profile, not source-code
constants. The default is `~/.local/share/secretary/profile.json`;
`SECRETARY_OWNER_FILE` can select an explicit profile for an isolated process.

## 1. Prepare

Install Node 22.16+ and run `npm ci`, then `npm run onboard`. Supply your name,
company email, Telegram numeric user ID and IANA timezone. Get your Telegram ID
from your own account; a username or bot ID is not an owner ID.

The command validates the profile, creates private runtime directories and inbox
schema, and renders configuration/workspace files under
`~/.local/share/secretary/setup`. Repeating identical setup is safe. A conflicting
existing file stops setup instead of replacing another owner's installation.

For agentic setup, save the same non-secret fields in a private JSON file:

```json
{
  "name": "Your name",
  "workEmail": "you@theopenengine.com",
  "telegramUserId": "123456789",
  "timezone": "Europe/Oslo"
}
```

Run `npm run onboard -- --profile /absolute/private/owner.json`. Optional
`slackUserId` and `slackTeamId` must be supplied together and verified against the
connected Slack account. `whatsappPhone` is your own international phone number;
`whatsappStoreDir` is the absolute path to your own paired bridge store. Add these
only when connecting those sources. Profile JSON rejects unknown fields: tokens
do not belong here. For fixture verification, `--home /temporary/directory`
redirects generated files without touching the real installation.

## 2. Sign in and connect Telegram

The reviewed runtime is OpenClaw 2026.9.6 with its Codex plugin 2026.9.6. Its
reviewed Node runtime is 26.10.0; keep this separate from the repo's Node 22 runtime
and native SQLite addon. See agent onboarding for the exact installation steps.

Run `openclaw onboard --install-daemon`. Choose your own model account and a new
Telegram bot created in BotFather. The setup default is Astra/high without model
fallbacks. Credentials stay on your machine. Do not paste tokens into your coding
agent chat, Slack, an issue or this repository.

Save your bot token in `~/.openclaw/telegram-token`, mode 600. The helper expects
this file rather than embedding the token in its generated JSON. Stop the gateway
while switching configuration. Then:

```sh
npm run onboard:apply
openclaw config validate
openclaw gateway restart
npm run onboard:doctor
openclaw health --json
```

Apply backs up the current OpenClaw config, keeps wizard authentication, selects a
separate `~/.openclaw/secretary-workspace`, and binds Telegram to your user ID with
all groups disabled. Existing connectors or conflicting workspace files require
an agent-reviewed merge, not automatic overwrite. No source connector is added by
this step. The model/plugin login must work before declaring the assistant ready.

Send the bot a message and verify it answers in your private chat. Confirm that
another account cannot instruct it. The doctor checks configuration; it does not
claim a successful live delivery.

## 3. Add sources, then verify

Follow [connectors.md](connectors.md). Start with one read-only source. Verify the
account identity, pagination and a full source conversation before enabling its
action connector. Every write connector must use the guarded wrapper and native
`prompt` approval mode. Personal email is read-only.

Use [verification.md](verification.md) to distinguish installed, connected,
read-tested and write-tested. Do not enable a background inbox watcher until its
account bindings and start time are set. Each person's database is independent.
