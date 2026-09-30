// Presentation only. Native approval IDs, ownership and decisions stay intact.
export function isSecretaryApproval(view) {
  if (view.approvalKind !== "plugin") return false;
  if (
    /^(?:mcp__)?(?:slack-actions|gmail-work-actions|whatsapp-actions|google-work-actions)__/.test(
      view.toolName ?? "",
    )
  )
    return true;
  return (
    view.toolName === "codex_mcp_tool_approval" &&
    /^MCP server: (slack-actions|gmail-work-actions|whatsapp-actions|google-work-actions)$/m.test(
      view.description ?? "",
    )
  );
}
export function secretaryApprovalActions(view) {
  return view.actions
    .filter((item) => ["allow-once", "deny"].includes(item.decision))
    .map((item) => ({
      ...item,
      label: item.decision === "allow-once" ? "Go ahead" : "Change / cancel",
    }));
}
export function secretaryApprovalStatus(view) {
  if (!isSecretaryApproval(view)) return null;
  if (view.phase === "expired")
    return "This request expired. Nothing was sent or changed.";
  return view.decision === "deny"
    ? "Cancelled. Tell me what to change if you want to revise it."
    : "Approved. I’ll confirm when it’s done.";
}
