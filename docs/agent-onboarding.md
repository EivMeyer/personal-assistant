# Agent onboarding contract

The user is asking you to complete setup, not merely describe it. Run commands,
render files, inspect results and fix local setup failures. Ask for user input
only for missing identity, account login/consent/pairing, and exact external
writes. Never borrow another person's credentials or identity. Do not send an
external test message from a generic instruction to install the assistant.

1. Read AGENTS.md and docs/onboarding.md. Run `npm ci`, `npm run onboard:plan` and
   `npm run onboard:doctor`. An incomplete doctor is expected on a fresh machine.
2. Collect the owner profile fields in one question. Do not ask for tokens in
   chat. Save a mode-600 JSON outside the repo and run
   `npm run onboard -- --profile /absolute/private/owner.json`.
3. Inspect installed runtime versions. If OpenClaw is absent, prepare an isolated
   runtime with `npm install --prefix "$HOME/.local/share/openclaw-runtime"
node@26.10.0 openclaw@2026.9.6`. Put a wrapper named `openclaw` under
   `~/.local/bin` that executes that runtime's `node_modules/node/bin/node` with
   `node_modules/openclaw/openclaw.mjs` and forwards arguments. Preserve an existing
   wrapper/runtime and report any version mismatch before replacing it.
4. Use `openclaw onboard --install-daemon` for the owner's model authentication
   and Telegram setup. Read current `--help` before invoking CLI options. Select
   the official Codex runtime and validate an actual Astra/high turn. Review the
   version-specific runtime patches under deploy/openclaw/action-preview; patches
   fail on unreviewed versions and must not be forced through string mismatches.
5. Obtain the owner's bot token through their local UI or token file, never chat.
   Store it at `~/.openclaw/telegram-token` with mode 600. Confirm the numeric owner
   ID is the user's account, not a bot/group. Stop the gateway during apply.
6. Run `npm run onboard:apply`. Validate the resulting OpenClaw config. If plugin
   trust/install registration is required, inspect `openclaw plugins install
--help` and register/link the local action-preview directory. Never remove the
   guard to make a connector work. Start/restart the gateway and verify health.
7. Run a read-only owner conversation. Use the owner's workspace USER.md and
   operating context; do not import this repository's test fixtures into memory.
   If OpenClaw migrates HEARTBEAT.md into automation scratch, update that exact
   automation with its current expected revision.
8. Add the requested sources through docs/connectors.md. Authenticate each as the
   owner. Update only that owner's private profile/settings. Keep unrelated sources
   disabled and distinguish an optional missing connector from a failed setup.
9. Run `npm run check`, then the repository Opcore checks if installed. Complete
   docs/verification.md for the connected sources. Keep live evidence outside Git.
   Show one exact external test action at a time. A successful API read, mock test
   or configured connector must never be reported as a passed external write.

The base setup deliberately refuses a merge into an existing connector-rich
installation. In that case inspect the generated overlay and existing config,
check the current owner binding, back up the existing files, and merge only the
required fields. Preserve native approvals, sender verification, workspace-only
filesystem access, model policy, and the finite tool allowlist.

The machine must be awake for local monitoring. Server migration is separate and
requires portable paths/dependencies, private credential transfer and a single
active Telegram poller. Apple Silicon transcription needs another tested local
backend on Linux. Do not provision infrastructure or promise always-on operation
as a side effect of workstation setup.
