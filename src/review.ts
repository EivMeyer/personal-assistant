import type { Proposal } from "./domain.ts";
import type { Outgoing } from "./store.ts";

export interface TelegramPayload {
  text: string;
  reply_markup?: Record<string, unknown>;
}
export function renderReview(
  proposal: Proposal,
  mode: "preview" | "live",
): TelegramPayload {
  const route = proposal.route;
  const lines = [
    `Proposal ${proposal.id} · v${proposal.version} · ${mode.toUpperCase()}`,
    `${proposal.source} · ${proposal.assessment.reason}`,
    `Incoming excerpt: ${proposal.contextPreview}`,
  ];
  if (route) {
    lines.push(`From: ${route.from}`, `To: ${route.to}`);
    if (route.channel === "gmail") lines.push("CC: none · BCC: none");
    if (route.subject) lines.push(`Subject: ${route.subject}`);
  }
  if (proposal.assessment.question)
    lines.push("", proposal.assessment.question);
  if (proposal.assessment.draft)
    lines.push("", "Exact reply:", proposal.assessment.draft);
  lines.push("", "Reply to this card to correct it. A correction never sends.");
  const button = (text: string, action: string) => ({
    text,
    callback_data: `${action}:${proposal.id}:${proposal.version}`,
  });
  const buttons = [
    button("Edit / answer", "edit"),
    button("Skip", "skip"),
    button("Later (1h)", "later"),
  ];
  if (proposal.state === "pending" && mode === "live")
    buttons.unshift(button("Approve and send", "approve"));
  const text = lines.join("\n");
  if (text.length > 4096)
    throw new Error(
      "Review exceeds Telegram limit; refusing to truncate an approval",
    );
  return { text, reply_markup: { inline_keyboard: [buttons] } };
}
export function renderOutgoing(outgoing: Outgoing): TelegramPayload {
  return {
    text: outgoing.text ?? "",
    ...(outgoing.forceReply
      ? { reply_markup: { force_reply: true, selective: true } }
      : {}),
  };
}
