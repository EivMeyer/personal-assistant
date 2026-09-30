import { createHash } from "node:crypto";
import { z } from "zod";

export type Channel = "gmail" | "whatsapp";
export interface Message {
  id: string;
  source: string;
  thread: string;
  channel: Channel;
  timestamp: number;
  sender: string;
  body: string;
  outgoing: boolean;
  automated: boolean;
  subject?: string;
  replyTo?: string;
  rfcMessageId?: string;
  references?: string[];
  attachments: boolean;
}
export interface Conversation {
  source: string;
  thread: string;
  messages: Message[];
  complete: boolean;
  gaps: string[];
}
export interface Route {
  channel: Channel;
  account: string;
  from: string;
  to: string;
  subject?: string;
  thread?: string;
  inReplyTo?: string;
  references?: string[];
}
export const assessmentSchema = z.object({
  decision: z.enum(["ignore", "digest", "ask"]),
  reason: z.string().min(1).max(600),
  question: z.string().max(700).nullable(),
  draft: z.string().max(1800).nullable(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type ProposalState =
  | "pending"
  | "needs_input"
  | "snoozed"
  | "skipped"
  | "superseded"
  | "sending"
  | "sent"
  | "uncertain"
  | "expired";
export interface Proposal {
  id: string;
  version: number;
  source: string;
  thread: string;
  state: ProposalState;
  assessment: Assessment;
  route: Route | null;
  contextHash: string;
  createdAt: number;
  expiresAt: number;
  wakeAt: number | null;
  correction: string;
  receipt: string | null;
  contextPreview: string;
}
export interface Source {
  id: string;
  poll(): Promise<void>;
  conversation(thread: string): Promise<Conversation>;
  route(context: Conversation): Promise<Route | null>;
  send(proposal: Proposal): Promise<string>;
  verify(): Promise<void>;
  close?(): void;
}
export interface Planner {
  assess(
    context: Conversation,
    correction?: string,
    previous?: Assessment,
  ): Promise<Assessment>;
}
export function fingerprint(context: Conversation): string {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}
export function latestIncoming(context: Conversation): Message | undefined {
  return context.messages.findLast((message) => !message.outgoing);
}
export function assertReply(
  proposal: Proposal,
): asserts proposal is Proposal & { route: Route } {
  if (
    !proposal.route ||
    !proposal.assessment.draft ||
    proposal.assessment.question
  ) {
    throw new Error("Proposal is not an executable reply");
  }
  if (
    proposal.route.channel === "gmail" &&
    proposal.route.from !== "eivind@theopenengine.com"
  ) {
    throw new Error("Company sender required");
  }
}
