# Local action review

Open **Assistant Inbox** on the Mac, or run `node scripts/open-inbox.mjs`.
The interface at `http://127.0.0.1:18792` runs inside the existing OpenClaw
plugin. No second assistant daemon is started.

The main screen puts prepared actions and specific owner questions in **Approvals**.
Email previews identify the sender and exact recipients and body. Questions accept
an inline answer. **History** contains rejected actions and actual connector
outcomes. Unknown outcomes remain explicitly unknown and must be reconciled before
retrying. The compact to-do list remains separate from execution approvals.

The assistant can prepare multiple actions or ask for missing information.
Capturing a request never authorizes a send. Existing task captures are not
silently converted into executable actions.

## Review and execution

The `secretary_review` tool stages a concrete action or a question after reading
full relevant conversations. Source keys prevent duplicate staging. An answered
question can become a new prepared action using the same key. Background runs may
prepare actions, but cannot approve or execute them.

Opening an action checks the original source snapshot and starts a dedicated
owner review session. That session can request only the exact stored connector
call. The existing native MCP prompt, company-sender verification, guarded
connector, post-approval source refresh and execution receipt still apply.

The app displays exact recipients, sender, subject and body for email, plus the
complete action arguments. **Approve & send** resolves only the matching live
native approval. Native request ID, run ID, server/tool and action fingerprint
must agree. It never grants standing approval. Telegram and the app resolve the
same request, so the first decision wins. `/inbox` lists the shared queue in
Telegram; `/inbox review ACTION_ID` opens a staged action for native review.

Editing an action rejects its pending native approval and creates a new,
unapproved revision. Source changes block execution and require an updated
review. History uses durable connector receipts, not manually checked task boxes.
A completed connector receipt is not evidence that the recipient read a message.

## Installation and local access

Add `secretary_review` to the existing OpenClaw `tools.allow` list and accept the
plugin's declared tool capability when enabling the update. Preserve existing
allow/deny policy. The local gateway CLI supplies authenticated RPC transport;
only approval listing/resolution and assistant chat submission are exposed by
this adapter. No general gateway proxy is available to the browser.

Review records live alongside execution records in
`~/.local/share/secretary-actions/actions.sqlite`. Credentials, records and source
evidence stay outside Git. The launcher reads a private local token and exchanges
it for a random HttpOnly, SameSite=Strict cookie. Sessions expire after one day or
a service restart. Host, Origin and JSON write checks protect the loopback API.

The server binds to `127.0.0.1` only. Future hosting needs TLS, real user
identity, per-user runtime/storage isolation and backups. Do not expose the
loopback service publicly by changing its bind address or adding a tunnel.

## Validation

Run `npm run check` and the installed Opcore and Opcore Zero gates. The review
suite exercises exact owner/session binding, stale source blocking, one-time
execution, competing channel decisions, edited revisions, questions and receipts.
Tests use fictional identities and temporary databases. They do not send email,
Telegram or Slack messages; a real delivery test needs exact owner approval.
