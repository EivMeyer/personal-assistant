# Review queue

Everything waiting on you lives in the private Telegram chat with the assistant.
There is no other interface.

The assistant stages work with the `secretary_review` tool after reading the full
source conversations. Each staged item gets one Telegram message, edited in place
as the item changes:

- **Ready:** the exact recipients, subject and message. **Send…** opens the item;
  **Set aside** drops it. Nothing is sent from this message.
- **Question:** something the assistant needs from you. Reply to that message to
  answer. The answer goes straight to the assistant, which prepares the next step
  under the same item.
- **Closed:** done, set aside, blocked, expired or unknown, without buttons.

`/inbox` lists what is waiting. `/inbox review ITEM_ID` opens an item, like
**Send…**.

## Sending

**Send…** re-checks the source conversations first. If they changed, nothing is
sent and the item turns into a question. Otherwise it starts a review session that
may call only the exact stored action. That call shows the full preview and the
native **Go ahead / Change / cancel** prompt. Go ahead is the only approval; it
covers that one call. Company-sender verification, the guarded connector, the
post-approval source refresh and the terminal receipt all still apply. Only one
item can be open at a time.

Background runs may stage items but never open, approve or execute them.

## Storage and access

Items live in `review_items` in
`~/.local/share/secretary-actions/actions.sqlite`, next to the execution records.
Each row stores the Telegram message that shows it and the version that message
displays; the plugin syncs every five seconds. Items that closed before they were
ever shown are not posted.

Buttons and replies count only from the configured owner in the private chat.
Callback data carries the item version, so a stale button cannot act on a changed
item.

## Validation

Run `npm run check` and the installed Opcore gates. `review-telegram.test.mjs`
and `review.test.mjs` cover rendering, buttons, replies, stale versions, owner
checks, source changes and one-time execution with fictional identities and
temporary databases. They send nothing.
