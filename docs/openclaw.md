# OpenClaw integration

OpenClaw loads the plugin straight from `deploy/openclaw/action-preview` in this
checkout, so a gateway restart runs whatever the working tree holds. See
[connectors](connectors.md), [operations](operations.md),
[review queue](review-queue.md) and [verification](verification.md).

## Owner profile

The runtime has no built-in owner. It reads a private profile from
`~/.local/share/secretary/profile.json` (mode 600), or from the path in
`SECRETARY_OWNER_FILE`:

```json
{
  "name": "Owner name",
  "workEmail": "owner@example.com",
  "telegramUserId": "123456789",
  "timezone": "Europe/Oslo"
}
```

`telegramUserId` is the numeric user ID, not a username or bot ID. Optional
`slackUserId` and `slackTeamId` go together and must match the connected Slack
account. `whatsappPhone` is the owner's international number and
`whatsappStoreDir` the absolute path to the paired bridge store. Unknown fields
are rejected; tokens never belong here. A missing or invalid profile fails closed.

`workEmail` is your installation’s verified sending account. Other domains are
accepted; outgoing tools still verify the actual account against this exact address.
A second personal Gmail account is read-only.

The Telegram bot token lives in `~/.openclaw/telegram-token` (mode 600), and
`channels.telegram.allowFrom` holds only the owner's ID. `npm run doctor` checks
the profile, token, owner binding and guarded action connectors; it does not
prove a live delivery.
