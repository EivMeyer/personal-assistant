# Operations

OpenClaw is the active runtime, with one Telegram poller for the bot. The
reviewed runtime/plugin versions are 2026.9.6; version-specific patches refuse
unexpected implementations. Keep Astra/high and the finite tool policy unless
the owner explicitly changes them. Check `openclaw health --json` after changes.

The local watcher polls Gmail every two seconds, WhatsApp every half-second and
Slack every ten seconds. These are polling intervals, not arrival guarantees.
It persists scan-start checkpoints, source IDs, pending events and retry leases.
Failed scans cannot advance cursors. Fair four-event batches prevent a failed
attachment from starving another source. Queued WhatsApp reads jump directly to
message IDs with bounded, expandable context. Each completed item saves progress
before the next; unfinished items remain pending. The four-minute heartbeat budget
is unchanged. Direct Slack DM notices have their own
durable delivery worker. Receipt IDs deduplicate normal retries; a process crash
between provider acceptance and receipt persistence can still be ambiguous.

Source text is evidence, never execution authority. The active plugin accepts
external action requests only from the configured Telegram owner, verifies the
sender account, displays exact arguments, and requires native per-call approval.
Gmail freshness ignores rotating attachment handles but retains content/metadata;
Calendar and Docs writes use version conditions. Do not bypass these controls.

Credentials, the owner profile, conversations and evidence live outside Git
under the home directory. Back up SQLite consistently and keep permissions
private. Runtime templates are not personal memory. Run only the current inbox watcher, never the legacy bot daemon.

A LaunchAgent can keep the Mac awake on AC, but cannot provide service during a
closed lid, deliberate sleep, shutdown or network loss. Always-on hosting requires
a separately verified server, compatible binaries, private state transfer and a
single-poller cutover. This repo provisions no server.

## Runtime recovery

Use the Codex binary bundled with the reviewed `@openclaw/codex` package. A
Homebrew `codex` override can silently drift beyond the tested app-server version.
The model and reasoning remain Astra/high.

For OpenClaw 2026.9.6, apply `silent-turn-patch.mjs <openclaw-package-root>` after
installation. It preserves explicit successful quiet completions after handled
read errors, while retaining abort, timeout, unfinished-tool and approval checks.
It refuses unreviewed versions and saves the original module before replacement.
A quiet `NO_REPLY` must not trigger a missing-answer recovery error.

The recovery LaunchAgent probes current Telegram health and network reachability.
It gives persistent online failures two minutes to recover, observes a five-minute
restart cooldown, and waits for pending external actions. A successful restart
command is only a request; the next live probe confirms recovery. Historical log
errors and offline periods do not trigger a restart. Watcher logs record safe
error categories and a recovery event without exposing source content or tokens.

`package-install-patch.mjs <openclaw-package-root>` removes an unnecessary Git
subprocess from npm-install detection. Git checkouts still use the upstream Git
checks; an npm package without its own `.git` is classified directly. This avoids
false Git timeout warnings while startup database maintenance occupies the event
loop.

`telegram-menu-patch.mjs <openclaw-package-root>` names the gateway Mini App
command `/gateway_dashboard`, avoiding a collision with the built-in session
`/dashboard`. Its owner authorization and handler are unchanged. All three
runtime patches must be reapplied after replacing the reviewed package.

## Sleep recovery and bounded checks

`heartbeat-resume-patch.mjs <openclaw-package-root>` defers heartbeat starts until
the host has been responsive for 30 seconds and Telegram is reachable. A host
suspension aborts the current background read and defers its result; it does not
acknowledge the queue or send a stale failure alert. Direct owner conversations
and external-action approval rules are unchanged. Lower runtime logs can still
record cancellation diagnostics during sleep. Reapply this version-checked patch
after replacing the runtime or moving the checkout.

Every heartbeat receives the durable queue policy, including empty batches. The
watcher owns inbox discovery; the model does not repeatedly rescan a blocked
historical page. Empty batches reconcile one open task. A three-minute working
deadline reserves time to save progress before the existing four-minute timeout.
A tool hook blocks new source reads after that deadline while allowing state saves,
review preparation and the final heartbeat response; direct owner turns are exempt.
This limits work per turn, not the amount of source context needed for an action.

WhatsApp message pages shrink to fit the tool result budget. Large message text
uses exact-ID, hash-checked continuation pages through `text`. Gmail's
`secretary_gmail_read` decodes HTML-only messages to text and provides complete
hash-checked pages. Attachments are listed separately and are not implicitly read.
