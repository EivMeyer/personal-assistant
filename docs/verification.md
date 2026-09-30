# Per-installation verification

Record results privately with timestamps and source/API receipt IDs. Never copy
source messages or credentials into this repository. Use fictional fixtures for
unit tests and the person's real accounts only for approved integration tests.

| Stage          | What proves it                                                                               |
| -------------- | -------------------------------------------------------------------------------------------- |
| Local          | npm run check passes with no real credentials                                                |
| Owner binding  | Another account is refused; the owner gets a reply in their own private Telegram chat        |
| Source reads   | Actual account identity, full relevant conversation and pagination verified                  |
| Incoming Slack | A new DM from another account reaches Telegram; record source, detection and delivery times  |
| Recovery       | Failed reads preserve checkpoints; resume catches up without duplicate acknowledgments       |
| Physical sleep | The user sleeps/wakes their machine; inspect power logs and recovered source checkpoints     |
| External write | Exact approved preview, guarded execution, provider receipt and independent read-back        |
| Calendar       | Separately approved create, update and cancel on a temporary event; verify every state       |
| Docs           | Separately approved private creation and exact edit; verify text, identity and sharing state |
| Media          | Source hash, all pages/windows, actual rendered images/transcript, uncertainty reported      |

Do not call a replay a fresh arrival, process suspension whole-host sleep, backend
success a read receipt, or a contact sheet exhaustive video coverage. Inspect
specific frame timestamps for brief events/small text. Confirm uncertain names,
numbers and commitments rather than turning model confidence into facts.

External test sends, calendar changes and document edits require the owner's
exact approval. Local unit tests do not. Check new replies and relevant source
state immediately before each live mutation. If a send outcome is unknown,
reconcile provider state before retrying.
