function stableBlocks(value) {
  if (Array.isArray(value)) return value.map(stableBlocks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "block_id")
      .map(([key, item]) => [key, stableBlocks(item)]),
  );
}
export function normalizeSlackMessages(messages) {
  // Slack synthesizes new display block IDs for some unchanged legacy messages.
  // Preserve all message evidence; ignore only these non-content IDs in blocks.
  return messages.map((message) =>
    message.blocks
      ? { ...message, blocks: stableBlocks(message.blocks) }
      : message,
  );
}
