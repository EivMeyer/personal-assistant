# Personal assistant

Eivind's own assistant. Telegram is the only interface. It reads connected
inboxes, notices what needs attention, prepares replies and calendar/document
changes, and asks for exact approval in Telegram before any external action.

This is a personal tool, not a product or a team setup. Credentials, the owner
profile, memories and source evidence live outside Git.

## What works

- Telegram conversation, reminders and a review queue: one message per prepared
  action or question, with buttons, edited in place. See
  [the review queue](docs/review-queue.md).
- Gmail, Slack, Discord, GitHub and a local WhatsApp bridge as sources.
- Company Calendar and Docs readers and guarded action connectors.
- WhatsApp images, local audio transcription and video inspection on Apple Silicon.
- Durable inbox checkpoints, retries, sender checks and delivery receipts.

Monitoring pauses while the Mac sleeps or is offline. A green build does not
prove the accounts work; use [the verification checklist](docs/verification.md).

## Development

```sh
npm ci
npm run check
npm run doctor
```

Tests use fictional fixtures and never send real messages. OpenClaw loads the
plugin under `deploy/openclaw` straight from this checkout; the watcher is
`src/openclaw`. The older TypeScript service is a
[legacy reference](docs/legacy-service.md). Never run two Telegram pollers on one
bot.

[OpenClaw setup](docs/openclaw.md) · [Operations](docs/operations.md) ·
[Connectors](docs/connectors.md)
