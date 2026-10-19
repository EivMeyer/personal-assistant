const guidance = [
  "Use secretary_review for the owner's shared action review queue. Read full relevant conversations before staging actions.",
  "Use propose with a stable source key, title, exact connector server, tool and complete args, including secretary_sources and timeoutMs:210000. Staging never executes or approves an action.",
  "Use question for specific missing owner input. List before staging; reuse source keys and do not duplicate resolved work. After an answer, propose with the same source key to replace the answered question.",
  "On background monitoring, put actionable findings here as well as in working notes. The queue posts each staged item to Telegram as its own message; never repeat or summarize it in your reply. Backfill at most two still-outstanding TASKS.md items per run after refreshing sources. Do not revive completed or owner-handled work.",
  "For an owner-opened review session, load the exact action and invoke only that tuple to request native approval. Native prompts and verified receipts remain mandatory. Never repeat a completed or uncertain send.",
].join(" ");
export function registerReviewTools(api, getReview, onStaged = () => {}) {
  api.on("before_prompt_build", (_e, ctx) =>
    ctx.agentId === "main" ? { prependContext: guidance } : undefined,
  );
  api.registerTool(
    (ctx) => {
      if (!allowedContext(ctx)) return null;
      return {
        name: "secretary_review",
        label: "Action review queue",
        description:
          "Stage exact actions or questions in the owner's Telegram review queue. Never executes or approves actions.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["list", "load", "propose", "question"],
            },
            key: { type: "string" },
            title: { type: "string" },
            question: { type: "string" },
            action: {
              type: "object",
              properties: {
                server: {
                  type: "string",
                  enum: [
                    "gmail-work-actions",
                    "google-work-actions",
                    "slack-actions",
                    "whatsapp-actions",
                  ],
                },
                tool: { type: "string" },
                args: { type: "object", additionalProperties: true },
              },
              required: ["server", "tool", "args"],
              additionalProperties: false,
            },
          },
          required: ["operation"],
          additionalProperties: false,
        },
        async execute(_id, p) {
          ctx.assertInvocationCurrent?.();
          const review = getReview();
          let result;
          if (p.operation === "list")
            result = review.store.list().map(({ snapshot: _, ...r }) => r);
          else if (p.operation === "load") {
            result = review.store.activeForSession(ctx.sessionKey);
            if (!result) throw Error("No action bound to this session.");
          } else if (["propose", "question"].includes(p.operation)) {
            result = await review.propose({
              key: p.key,
              title: p.title,
              question: p.question,
              action: p.operation === "propose" ? p.action : undefined,
            });
            onStaged(ctx);
          } else throw Error("Unknown review operation.");
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { names: ["secretary_review"] },
  );
}
function allowedContext(ctx) {
  // This tool only prepares suggestions in the private main agent's queue.
  // Owner approval is enforced by the separate native execution path.
  return ctx.agentId === "main";
}
