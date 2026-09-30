# Company personal assistant

An internal assistant for each person at The Open Engine. Telegram is the owner
interface. It reads connected inboxes, prepares replies and calendar/document
changes, and asks for approval before external actions.

**Each person runs a separate instance with their own accounts and credentials.**
This repository shares code, not anyone's inbox, contacts, memories or sessions.

## Set it up

On a Mac with Node 22.16+ and npm:

```sh
git clone https://github.com/the-open-engine/personal-assistant.git
cd personal-assistant
npm ci
npm run onboard
```

The guided command collects your identity and prepares your own private settings
and workspace. It does not copy another person's accounts or activate sending.
Follow [the short setup guide](docs/onboarding.md) to connect your model login and
Telegram bot, then add inboxes one at a time.

## Let an agent do the setup

Open this repository in your coding agent and paste:

> Set up my own company assistant. Follow docs/agent-onboarding.md, run the setup
> plan, and complete the steps you can. Ask me only for missing identity details,
> account sign-in/pairing, and exact approvals for external test actions. Never use
> anyone else's tokens, inbox, bot, memories or owner profile.

The agent can use `npm run onboard:plan` and `npm run onboard:doctor` for structured
progress. OAuth consent and WhatsApp pairing still require you.

## What works

- Telegram conversations, reminders, proposals and exact action approvals.
- Gmail, Slack and a local WhatsApp bridge for incoming correspondence.
- Company Calendar and Docs readers and guarded action connectors.
- WhatsApp images, local audio transcription and video inspection on Apple Silicon.
- Durable inbox checkpoints, retries, sender checks and delivery receipts.

Connectors are optional and start disconnected. A green build does not prove your
accounts work: use [the per-person verification checklist](docs/verification.md).
Slack search indexing adds latency. Video overviews sample frames; uncertain
speech and small/brief visual details need closer review. Monitoring pauses when
its host is asleep or offline. Always-on hosting is a separate deployment.

## Development

```sh
npm run check
```

Tests use fictional account fixtures and never send real messages. The active
integration is under `deploy/openclaw`; the watcher is `src/openclaw`. The older
service remains as a [legacy reference](docs/legacy-service.md), not the default
startup path. Do not run two Telegram pollers on one bot.

[Operations](docs/operations.md) · [Connectors](docs/connectors.md) ·
[Agent onboarding](docs/agent-onboarding.md)
