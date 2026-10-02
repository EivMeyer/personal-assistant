const HIDDEN = new Set([
  "secretary_sources",
  "timeoutMs",
  "expectedEtag",
  "expectedRevisionId",
]);
const LABELS = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Message",
  text: "Message",
  from: "From",
  channel_id: "To",
  recipient: "To",
  thread_ts: "Reply in thread",
  threadId: "Email conversation",
  content_type: "Message format",
  htmlBody: "HTML message",
  attachments: "Attachments",
  expectedSummary: "Current appointment",
  expectedTitle: "Current document",
  expectedOrganizer: "Organizer",
  expectedAttendees: "Current guests",
  acknowledgeShared: "Edit a shared document",
  tabId: "Document tab",
  documentId: "Document",
  eventId: "Appointment",
  summary: "Appointment",
  start: "Starts",
  end: "Ends",
  attendees: "Guests",
  title: "Title",
  edit: "Change",
  kind: "Operation",
  find: "Replace this text",
  replacement: "With",
  expectedOccurrences: "Number of replacements",
};
const QUESTIONS = {
  send_email: "Send this email?",
  reply_email: "Send this reply?",
  send_message: "Send this WhatsApp message?",
  conversations_add_message: "Send this Slack message?",
  calendar_create: "Create this appointment and invite the guests listed?",
  calendar_update: "Update this appointment and notify its guests?",
  calendar_cancel: "Cancel this appointment and notify its guests?",
  calendar_rsvp: "Send this meeting response?",
  document_create: "Create this private document?",
  document_edit: "Make this change to the document?",
};
function label(key) {
  return (
    LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")
  );
}
function valueText(value) {
  if (Array.isArray(value)) return value.map(valueText).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) => label(key) + ": " + valueText(item))
      .join("\n");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value ?? "");
}
// The visible fields of an action, one line each, as the approval shows them.
export function actionFieldLines(params, destination) {
  const lines = [];
  for (const [key, value] of Object.entries(params)) {
    if (HIDDEN.has(key)) continue;
    if (key === "channel_id" && destination) {
      lines.push("To: " + destination);
      continue;
    }
    if (key === "content_type") {
      const format = {
        "text/plain": "Plain text",
        "text/markdown": "Formatted text",
      }[value];
      lines.push("Message format: " + (format ?? valueText(value)));
      continue;
    }
    lines.push(label(key) + ": " + valueText(value));
  }
  return lines;
}
export function actionPreviewText({ tool, params, identity, destination }) {
  const lines = [
    QUESTIONS[tool] ?? "Go ahead with this action?",
    "From: " + identity,
    ...actionFieldLines(params, destination),
  ];
  if (!QUESTIONS[tool]) lines.splice(1, 0, "Action: " + label(tool));
  return (
    lines.join("\n\n") +
    "\n\nUse the buttons below. To revise it, choose ‘Change / cancel’ and tell me what to change."
  );
}
export function actionReceiptText(row) {
  const args = JSON.parse(row.args);
  const outcome = JSON.parse(row.outcome);
  if (row.state === "unknown")
    return "I couldn’t confirm whether this went through. I haven’t tried again.";
  if (row.state === "blocked") {
    const detail = /source conversation changed/.test(outcome.message ?? "")
      ? "The conversation changed while you were reviewing it. I need to check the new messages first."
      : "I couldn’t complete the checks needed to carry this out.";
    return "Nothing sent or changed. " + detail;
  }
  if (row.state === "failed")
    return "This didn’t go through. I’ll check what failed before trying again.";
  if (row.state !== "completed") return "This hasn’t completed yet.";
  return completedReceipt(row, args);
}

function completedReceipt(row, args) {
  const sendTools = new Set([
    "send_email",
    "reply_email",
    "send_message",
    "conversations_add_message",
  ]);
  const sent =
    sendTools.has(row.tool) &&
    {
      "slack-actions": "Sent on Slack.",
      "gmail-work-actions": "Email sent.",
      "whatsapp-actions": "Sent on WhatsApp.",
    }[row.server];
  const done = {
    calendar_create: "Appointment created.",
    calendar_update: "Appointment updated.",
    calendar_cancel: "Appointment cancelled.",
    calendar_rsvp: "Meeting response sent.",
    document_create: "Document created.",
    document_edit: "Document updated.",
  }[row.tool];
  const content = args.text ?? args.body;
  const echo =
    typeof content === "string" && content.length <= 1000
      ? "\n\n" + content
      : "";
  return (sent || done || "Done.") + echo;
}
