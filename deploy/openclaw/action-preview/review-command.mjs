export async function reviewCommand(ctx, review) {
  try {
    const args = (ctx.args ?? "").trim().split(/\s+/);
    review.store.reconcile();
    const items = review.store.list();
    if (args[0] === "review") {
      const matches = items.filter(
        (item) => args[1]?.length >= 8 && item.id.startsWith(args[1]),
      );
      if (matches.length !== 1)
        throw Error("Use the unique action ID shown by /inbox.");
      ctx.assertOwnerCurrent?.();
      await review.open(matches[0].id, matches[0].version);
      return {
        text: "Checking this action. Review the exact native approval when it arrives; opening it has not approved a send.",
      };
    }
    const active = items
      .filter((item) => ["ready", "needs_info", "opening"].includes(item.state))
      .slice(0, 15);
    return {
      text:
        (active.length
          ? active
              .map(
                (item) =>
                  `${item.id.slice(0, 8)} · ${item.state}\n${item.title}${item.question ? "\n" + item.question : ""}`,
              )
              .join("\n\n")
          : "No prepared actions or questions are waiting.") +
        "\n\nUse /inbox review ACTION_ID to open a prepared action. The Mac app shows the same queue. Native approvals can be resolved in either place.",
    };
  } catch (error) {
    return { text: error.message };
  }
}
