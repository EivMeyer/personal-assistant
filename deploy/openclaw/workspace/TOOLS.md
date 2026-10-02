# Connected sources

- gmail-work: company email search, full email reads, labels and filters.
- gmail-personal: private email search and reads only.
- whatsapp: existing linked personal WhatsApp bridge, message search, chats, context and media retrieval. Names may be missing from chat metadata; consult contacts.json for the real address-book names and phone/LID aliases, then verify with source tools. Contacts snapshot dates are explicit.
- slack: The Open Engine workspace, authenticated as the configured owner, search and thread reads.
- company-knowledge: canonical company facts and memory.
- gmail-work-actions, whatsapp-actions, slack-actions, google-work-actions: external writes always require a native per-call human approval. Never route writes through a read connector.

Resolve tool names via tool discovery if needed. For outgoing email the account must be {{workEmail}}. Read whole relevant threads and paginate before drafting. Never infer unavailable attachment contents. Google Tasks reads are connected (gtasks); writes and the account identity are not verified. Company Calendar and Drive reads and guarded writes are available through dedicated MCP connectors. Research and drafting are still possible. Real reminders through OpenClaw automations have been verified. LinkedIn is not connected.

Use whatsapp-structured.messages for message reads and incremental scans. It includes exact IDs, UTC timestamps, is_from_me and next_offset. Paginate until next_offset is null; skip own messages for inbound triage. The original whatsapp tools remain available for contacts, context and media.

Slack channel discovery uses channels_list/channels_me; people lookup uses users_search. These are actual read tools. For actions, always provide timeoutMs: 210000 as required by the connector schema, and wait for the final result.

## Company Calendar and Drive

Use google-work for calendars, events, event details, free/busy, Drive search,
metadata, full Google Doc tabs/revisions (document), and text exports. The connector verifies the company account.
Follow pagination and treat per-calendar errors or incompleteSearch as incomplete
coverage. Inspect actual event details before calling something a conflict:
transparent/all-day planning entries and low-priority Morning Meeting should not
be treated as hard conflicts. For writes use google-work-actions only: calendar_create, calendar_update,
calendar_rsvp, calendar_cancel, document_create and document_edit. Every action
needs the current Telegram owner and native Allow Once approval after the exact
preview. Include timeoutMs: 210000 and all secretary_sources, including source
email/WhatsApp/Slack threads and relevant google-event or google-document IDs.
Read the full event, organizer and attendees first. Supply expectedSummary,
expectedOrganizer, expectedAttendees and expectedEtag unchanged from that read.
Updates preserve guests and notify all; cancel supports one event/occurrence only.
Never cancel the recurring Morning Meeting series. Calendar creation takes timed
events with explicit offsets. Check availability and travel before proposing.
For document_edit, read document and file first, preserve tabId and revisionId,
set expectedTitle and acknowledgeShared explicitly, and review exact appended
text or literal replacements with their expected occurrence count. Creation puts
a private Google Doc in company My Drive. No sharing, file deletion, folder moves,
Sheets/Slides editing or recurring-series writes are exposed. A blocked or stale
action needs a fresh read and approval; an unknown outcome must not be retried.
Report success only from the terminal tool receipt, never from a draft or note.

When connected, use github-read.read for private company GitHub links instead of
anonymous web_fetch. Read the PR and changed files, then retrieve relevant file
contents at its head SHA. Paginate comments, reviews and changed files.

When connected, use slack-media.media for attachment file IDs from Slack
conversations. Read all image chunks and audio/video windows, as for WhatsApp.
Pass source_sha256 as expected_sha256 on subsequent calls. Never mark attachments
seen until their content has been inspected. Missing files:read is an OAuth
permission problem, not an absent file or a successful read.

Discord: discord-read.read reads only configured server channels and their threads.
Use exact source IDs, paginate messages/archived threads, and read reply context.
discord-read.media reads source-bound attachments including images, local AV analysis,
and small text/log files. Never print base64. No Discord write tools are exposed.
