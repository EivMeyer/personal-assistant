import { Store } from "./store.ts";
import { openDatabase } from "./database.ts";
import { Engine } from "./engine.ts";
import { renderReview } from "./review.ts";
import type { Conversation, Planner, Proposal, Source } from "./domain.ts";

const context: Conversation = {
  source: "demo",
  thread: "alex",
  complete: true,
  gaps: [],
  messages: [
    {
      id: "demo-message",
      source: "demo",
      thread: "alex",
      channel: "whatsapp",
      timestamp: 1,
      sender: "Alex",
      body: "Could you send me an update?",
      outgoing: false,
      automated: false,
      attachments: false,
    },
  ],
};
const sent: Proposal[] = [];
const source: Source = {
  id: "demo",
  poll: async () => {},
  verify: async () => {},
  conversation: async () => context,
  route: async () => ({
    channel: "whatsapp",
    account: "demo",
    from: "Eivind (simulated)",
    to: "Alex (simulated)",
  }),
  send: async (proposal) => {
    sent.push(proposal);
    return "SIMULATED-ONLY";
  },
};
const planner: Planner = {
  assess: async (_context, correction) => ({
    decision: "ask",
    reason: "Alex requested an update.",
    question: null,
    draft: correction
      ? "I will send an update on Friday."
      : "I will send an update tomorrow.",
  }),
};
const store = new Store(openDatabase(":memory:"));
const engine = new Engine(store, new Map([["demo", source]]), planner, {
  mode: "live",
  approvalHours: 24,
  maxContextChars: 80_000,
  maxAssessmentsPerDay: 100,
  mutedThreads: [],
});
try {
  store.schedule("demo", "alex", 0);
  await engine.processJobs();
  const original = store.proposals(["pending"])[0]!;
  console.log("OFFLINE DEMO: no network, credentials, or real messages.\n");
  console.log(renderReview(original, "live").text);
  console.log("\nOwner correction: Make it Friday.");
  await engine.correct(original.id, 1, "Make it Friday");
  console.log(renderReview(store.proposal(original.id)!, "live").text);
  console.log("\nOld approval:", await engine.approve(original.id, 1));
  console.log("Current approval:", await engine.approve(original.id, 2));
  console.log("Repeated approval:", await engine.approve(original.id, 2));
  if (sent.length !== 1) throw new Error("Demo failed: duplicate execution");
  console.log("\nPASS: exactly one simulated send, for the corrected version.");
} finally {
  store.db.close();
}
