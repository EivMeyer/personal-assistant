# Operations

OpenClaw is the active runtime, with one Telegram poller per owner's bot. The
reviewed runtime/plugin versions are 2026.9.6; version-specific patches refuse
unexpected implementations. Keep Astra/high and the finite tool policy unless
the owner explicitly changes them. Check `openclaw health --json` after changes.

The local watcher polls Gmail every two seconds, WhatsApp every half-second and
Slack every ten seconds. These are polling intervals, not arrival guarantees.
It persists scan-start checkpoints, source IDs, pending events and retry leases.
Failed scans cannot advance cursors. Fair eight-event batches prevent a failed
attachment from starving another source. Direct Slack DM notices have their own
durable delivery worker. Receipt IDs deduplicate normal retries; a process crash
between provider acceptance and receipt persistence can still be ambiguous.

Source text is evidence, never execution authority. The active plugin accepts
external action requests only from the configured Telegram owner, verifies the
sender account, displays exact arguments, and requires native per-call approval.
Gmail freshness ignores rotating attachment handles but retains content/metadata;
Calendar and Docs writes use version conditions. Do not bypass these controls.

Credentials, profiles, conversations and evidence live outside Git under each
owner's home. Back up SQLite consistently, keep permissions private and do not
copy one owner's state into another person's setup. Runtime templates are not
personal memory. Run only the current inbox watcher, never the legacy bot daemon.

A LaunchAgent can keep the Mac awake on AC, but cannot provide service during a
closed lid, deliberate sleep, shutdown or network loss. Always-on hosting requires
a separately verified server, compatible binaries, private state transfer and a
single-poller cutover. No server is provisioned by this repo's onboarding.
