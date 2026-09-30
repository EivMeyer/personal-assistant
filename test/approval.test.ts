import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";

test("concurrent approvals claim the send only once", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  await Promise.all([h.engine.approve(p.id, 1), h.engine.approve(p.id, 1)]);
  assert.equal(h.source.sends.length, 1);
});

test("an edit completing after approval cannot restore a sent draft", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.planner.assess = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      decision: "ask",
      reason: "Revised",
      question: null,
      draft: "Another draft",
    };
  };
  const correction = h.engine.correct(p.id, 1, "Revise");
  await started;
  await h.engine.approve(p.id, 1);
  release();
  await correction;
  assert.equal(h.store.proposal(p.id)?.state, "sent");
  assert.equal(h.source.sends.length, 1);
});

test("correction requires the revised version; repeated approvals send once", async (t) => {
  const h = harness();
  t.after(h.close);
  const proposal = await h.propose();
  await h.engine.correct(proposal.id, 1, "Make it Friday");
  await h.engine.approve(proposal.id, 1);
  assert.equal(h.source.sends.length, 0);
  await h.engine.approve(proposal.id, 2);
  await h.engine.approve(proposal.id, 2);
  assert.equal(h.source.sends.length, 1);
  assert.equal(
    h.source.sends[0]?.assessment.draft,
    "I will send an update Friday.",
  );
  assert.equal(h.store.proposal(proposal.id)?.state, "sent");
});
test("a new incoming message invalidates approval without sending", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  appendMessage(h, "Actually never mind", false);
  assert.match(await h.engine.approve(p.id, 1), /changed/);
  assert.equal(h.source.sends.length, 0);
  assert.equal(h.store.proposal(p.id)?.state, "superseded");
});
test("expired and preview approvals cannot send", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  h.advance(86_400_001);
  await h.engine.approve(p.id, 1);
  assert.equal(h.store.proposal(p.id)?.state, "expired");
  assert.equal(h.source.sends.length, 0);
  const preview = harness("preview");
  t.after(preview.close);
  const draft = await preview.propose();
  await preview.engine.approve(draft.id, 1);
  assert.equal(preview.source.sends.length, 0);
});
test("wrong identity or routing changes cannot execute", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  h.source.verifyError = true;
  await assert.rejects(h.engine.approve(p.id, 1), /identity/);
  h.source.verifyError = false;
  h.source.replyRoute.to = "Someone else";
  await h.engine.approve(p.id, 1);
  assert.equal(h.source.sends.length, 0);
});
test("ambiguous provider result is never retried and blocks new drafts for the thread", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  h.source.sendError = true;
  await h.engine.approve(p.id, 1);
  await h.engine.approve(p.id, 1);
  await reassess(h);
  assert.equal(h.store.proposal(p.id)?.state, "uncertain");
  assert.equal(h.source.sends.length, 1);
  assert.equal(h.planner.calls, 1);
  assert.match(h.engine.resolve(p.id, "sent"), /No resend/);
  assert.equal(h.store.proposal(p.id)?.state, "sent");
});
test("a crash while sending recovers to uncertain, never pending", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  h.store.save({ ...p, state: "sending" });
  h.engine.recover();
  h.engine.recover();
  await h.engine.approve(p.id, 1);
  assert.equal(h.store.proposal(p.id)?.state, "uncertain");
  assert.equal(h.source.sends.length, 0);
});
test("manual reply invalidates an outstanding draft and requires no new one", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  appendMessage(h, "Already handled this", true);
  await reassess(h);
  assert.equal(h.store.proposal(p.id)?.state, "superseded");
  assert.equal(h.planner.calls, 1);
});
test("missing or oversized context produces a question without an executable draft", async (t) => {
  const h = harness();
  t.after(h.close);
  h.source.context.complete = false;
  const p = await h.propose();
  assert.equal(p.state, "needs_input");
  assert.equal(p.assessment.draft, null);
  await h.engine.approve(p.id, 1);
  assert.equal(h.planner.calls, 0);
  assert.equal(h.source.sends.length, 0);
});
test("later does not approve; wakeup requires fresh assessment", async (t) => {
  const h = harness();
  t.after(h.close);
  const p = await h.propose();
  h.engine.dismiss(p.id, 1, "later");
  await h.engine.approve(p.id, 1);
  assert.equal(h.source.sends.length, 0);
  h.advance(3_600_001);
  await h.engine.processJobs();
  await h.engine.processJobs();
  assert.equal(h.store.proposal(p.id)?.state, "superseded");
  assert.equal(h.planner.calls, 2);
});

async function reassess(h: ReturnType<typeof harness>): Promise<void> {
  h.store.schedule("fake", "alice", 0);
  await h.engine.processJobs();
}

function appendMessage(
  h: ReturnType<typeof harness>,
  body: string,
  outgoing: boolean,
): void {
  h.source.context.messages.push({
    ...h.source.context.messages[0]!,
    id: "new-message",
    timestamp: 3000,
    body,
    outgoing,
  });
}
