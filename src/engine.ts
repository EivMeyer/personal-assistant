import { randomBytes } from "node:crypto";
import {
  assertReply,
  fingerprint,
  latestIncoming,
  type Assessment,
  type Conversation,
  type Planner,
  type Proposal,
  type Source,
} from "./domain.ts";
import { Store, type Job } from "./store.ts";

export interface EngineOptions {
  mode: "preview" | "live";
  approvalHours: number;
  maxContextChars: number;
  maxAssessmentsPerDay: number;
  mutedThreads: string[];
  now?: () => number;
}
export class Engine {
  readonly now: () => number;
  constructor(
    readonly store: Store,
    readonly sources: Map<string, Source>,
    private readonly planner: Planner,
    readonly options: EngineOptions,
  ) {
    this.now = options.now ?? Date.now;
  }
  recover(): void {
    this.store.db.transaction(() => {
      for (const proposal of this.store.proposals(["sending"])) {
        this.store.save({ ...proposal, state: "uncertain" });
        this.notice(
          `recover:${proposal.id}`,
          `Delivery for ${proposal.id} is uncertain after restart. Check the source app. I will not resend.`,
        );
      }
    })();
  }
  async processJobs(): Promise<void> {
    for (const job of this.store.jobs(this.now()).slice(0, 1)) {
      try {
        await this.process(job);
      } catch {
        this.store.fail(job, this.now());
        this.store.audit(
          "triage_failed",
          job.source,
          "Will retry with backoff",
          this.now(),
        );
        if (job.attempts === 2)
          this.notice(
            `triage-error:${job.source}:${job.thread}`,
            `${job.source}: a conversation could not be assessed after repeated attempts. Check service health.`,
          );
      }
    }
    this.wakeSnoozed();
  }
  private async process(job: Job): Promise<void> {
    const context = await this.source(job.source).conversation(job.thread);
    const blocked = this.store
      .proposals(["sending", "uncertain"])
      .some((p) => p.source === job.source && p.thread === job.thread);
    if (blocked) {
      this.store.finish(job);
      return;
    }
    const reason = this.ignoreReason(context);
    if (reason) {
      this.store.db.transaction(() => {
        this.store.supersede(job.source, job.thread);
        this.store.audit("ignored", job.source, reason, this.now());
        this.store.finish(job);
      })();
      return;
    }
    const assessment = await this.assess(context);
    const route = assessment.draft
      ? await this.source(job.source).route(context)
      : null;
    const proposal = this.makeProposal(context, assessment, route);
    this.store.db.transaction(() => {
      this.store.supersede(job.source, job.thread);
      if (assessment.decision === "ask") {
        this.store.save(proposal);
        this.queueCard(proposal);
      } else if (assessment.decision === "digest") {
        this.store.set(
          `digest:${proposal.id}`,
          `${job.source}: ${assessment.reason}`,
        );
      }
      this.store.audit("triaged", job.source, assessment.decision, this.now());
      this.store.finish(job);
    })();
  }
  private ignoreReason(context: Conversation): string | undefined {
    if (
      this.options.mutedThreads.includes(`${context.source}:${context.thread}`)
    )
      return "muted";
    const latest = context.messages.at(-1);
    if (!latest) return "empty";
    if (latest.outgoing) return "already_replied";
    if (latest.automated) return "automated";
    return undefined;
  }
  private async assess(
    context: Conversation,
    correction?: string,
    previous?: Assessment,
  ): Promise<Assessment> {
    if (
      !context.complete ||
      JSON.stringify(context).length > this.options.maxContextChars
    ) {
      return {
        decision: "ask",
        reason: "The available conversation is incomplete or too large.",
        question:
          "Please review this conversation in the source app. I cannot safely draft or send from partial context.",
        draft: null,
      };
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = `model-calls:${day}`;
    const count = Number(this.store.get(key) ?? 0);
    if (count >= this.options.maxAssessmentsPerDay)
      throw new Error("Daily model budget reached");
    this.store.set(key, String(count + 1));
    return this.planner.assess(context, correction, previous);
  }
  private makeProposal(
    context: Conversation,
    assessment: Assessment,
    route: Proposal["route"],
  ): Proposal {
    if (assessment.question) assessment = { ...assessment, draft: null };
    if (assessment.draft && !route)
      assessment = {
        ...assessment,
        draft: null,
        question:
          "I cannot verify a reply route for this conversation. Please handle it in the source app.",
      };
    if (!assessment.draft && !assessment.question)
      assessment = { ...assessment, question: "What would you like to say?" };
    return {
      id: randomBytes(8).toString("hex"),
      version: 1,
      source: context.source,
      thread: context.thread,
      state:
        assessment.draft && !assessment.question && route
          ? "pending"
          : "needs_input",
      assessment,
      route,
      contextHash: fingerprint(context),
      createdAt: this.now(),
      expiresAt: this.now() + this.options.approvalHours * 3_600_000,
      wakeAt: null,
      correction: "",
      receipt: null,
      contextPreview: contextPreview(context),
    };
  }
  async correct(id: string, version: number, text: string): Promise<string> {
    const proposal = this.reviewable(id, version);
    if (!proposal)
      return "This proposal has changed or is no longer available. Use its newest card.";
    if (text.length > 2000 || proposal.correction.length + text.length > 8000)
      return "Correction is too long. Please shorten it.";
    const context = await this.source(proposal.source).conversation(
      proposal.thread,
    );
    if (fingerprint(context) !== proposal.contextHash)
      return this.invalidate(proposal);
    const correction = `${proposal.correction}\n${text}`.trim();
    const assessment = await this.assess(
      context,
      correction,
      proposal.assessment,
    );
    const route = assessment.draft
      ? await this.source(proposal.source).route(context)
      : null;
    const updated = this.makeProposal(
      context,
      { ...assessment, decision: "ask" },
      route,
    );
    Object.assign(updated, {
      id: proposal.id,
      version: proposal.version + 1,
      correction,
    });
    const saved = this.store.db.transaction(() => {
      if (!this.reviewable(id, version)) return false;
      this.store.save(updated);
      this.queueCard(updated);
      this.store.audit(
        "corrected",
        id,
        `version:${updated.version}`,
        this.now(),
      );
      return true;
    })();
    return saved
      ? "Updated draft prepared. It needs fresh approval."
      : "This proposal changed while you were editing. Use the newest card.";
  }
  async approve(id: string, version: number): Promise<string> {
    if (this.options.mode !== "live")
      return "Preview mode: sending is disabled.";
    const proposal = this.reviewable(id, version);
    if (!proposal || proposal.state !== "pending")
      return "This draft cannot be approved. Use its newest card.";
    assertReply(proposal);
    const source = this.source(proposal.source);
    await source.verify();
    const context = await source.conversation(proposal.thread);
    if (!context.complete || fingerprint(context) !== proposal.contextHash)
      return this.invalidate(proposal);
    if (
      JSON.stringify(await source.route(context)) !==
      JSON.stringify(proposal.route)
    )
      return this.invalidate(proposal);
    const claimed = this.store.db.transaction(() => {
      if (!this.reviewable(id, version)) return false;
      this.store.save({ ...proposal, state: "sending" });
      this.store.audit("approved", id, `version:${version}`, this.now());
      return true;
    })();
    if (!claimed) return "Approval is no longer current.";
    return this.execute(source, proposal);
  }
  private async execute(source: Source, proposal: Proposal): Promise<string> {
    try {
      const receipt = await source.send(proposal);
      this.store.db.transaction(() => {
        this.store.save({ ...proposal, state: "sent", receipt });
        this.store.audit("sent", proposal.id, receipt, this.now());
        this.notice(
          `sent:${proposal.id}`,
          `Sent ${proposal.id}. Receipt: ${receipt}`,
        );
      })();
      return "Sent.";
    } catch {
      this.store.save({ ...proposal, state: "uncertain" });
      this.store.audit(
        "delivery_uncertain",
        proposal.id,
        "No automatic retry",
        this.now(),
      );
      this.notice(
        `uncertain:${proposal.id}`,
        `Delivery of ${proposal.id} is uncertain. Check the source app before doing anything else. I will not retry.`,
      );
      return "Delivery uncertain. No automatic retry.";
    }
  }
  private reviewable(id: string, version: number): Proposal | undefined {
    const proposal = this.store.proposal(id);
    if (
      !proposal ||
      proposal.version !== version ||
      !["pending", "needs_input"].includes(proposal.state)
    )
      return undefined;
    if (proposal.expiresAt <= this.now()) {
      this.store.save({ ...proposal, state: "expired" });
      this.notice(
        `expired:${id}`,
        `Proposal ${id} expired. A fresh review is required.`,
      );
      return undefined;
    }
    return proposal;
  }
  private invalidate(proposal: Proposal): string {
    this.store.db.transaction(() => {
      if (!this.reviewable(proposal.id, proposal.version)) return;
      this.store.save({ ...proposal, state: "superseded" });
      this.store.schedule(proposal.source, proposal.thread, this.now());
    })();
    return "The conversation or reply route changed. I will review it again before proposing a new action.";
  }
  dismiss(id: string, version: number, action: "skip" | "later"): string {
    const proposal = this.reviewable(id, version);
    if (!proposal) return "This proposal is no longer current.";
    this.store.save({
      ...proposal,
      state: action === "skip" ? "skipped" : "snoozed",
      wakeAt: this.now() + 3_600_000,
    });
    return action === "skip" ? "Skipped." : "Snoozed for one hour.";
  }
  requestEdit(id: string, version: number): string {
    if (!this.reviewable(id, version))
      return "This proposal is no longer current.";
    this.store.enqueue(
      `edit:${id}:${version}`,
      {
        proposalId: id,
        version,
        text: "Reply to this message with your correction or answer.",
        forceReply: true,
      },
      this.now(),
    );
    return "Reply to the correction prompt.";
  }
  resolve(id: string, resolution: "sent" | "skip"): string {
    const proposal = this.store.proposal(id);
    if (proposal?.state !== "uncertain")
      return "Only uncertain deliveries can be resolved.";
    this.store.save({
      ...proposal,
      state: resolution === "sent" ? "sent" : "skipped",
      receipt: "Manually resolved by owner",
    });
    this.store.audit("resolved", id, resolution, this.now());
    return "Recorded. No resend was attempted.";
  }
  private wakeSnoozed(): void {
    for (const proposal of this.store.proposals(["snoozed"])) {
      if ((proposal.wakeAt ?? Infinity) > this.now()) continue;
      this.requeue(proposal);
    }
  }
  refresh(id: string): string {
    const proposal = this.store.proposal(id);
    if (!proposal || ["sending", "uncertain", "sent"].includes(proposal.state))
      return "This proposal cannot be refreshed.";
    this.requeue(proposal);
    return "Fresh review scheduled. Any reply will need a new approval.";
  }
  private requeue(proposal: Proposal): void {
    this.store.db.transaction(() => {
      this.store.save({ ...proposal, state: "superseded" });
      this.store.schedule(proposal.source, proposal.thread, this.now());
    })();
  }
  queueCard(proposal: Proposal): void {
    this.store.enqueue(
      `card:${proposal.id}:${proposal.version}`,
      { proposalId: proposal.id, version: proposal.version },
      this.now(),
    );
  }
  notice(key: string, text: string): void {
    this.store.enqueue(key, { text }, this.now());
  }
  private source(id: string): Source {
    const source = this.sources.get(id);
    if (!source) throw new Error("Source is not configured");
    return source;
  }
}
function contextPreview(context: Conversation): string {
  const incoming = latestIncoming(context);
  if (!incoming) return "No incoming message available.";
  const text =
    incoming.body.length > 300
      ? `${incoming.body.slice(0, 300)}…`
      : incoming.body;
  return `${incoming.sender.slice(0, 100)}: ${text}`;
}
