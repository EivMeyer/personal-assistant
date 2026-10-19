// An attachment that can never be opened here: an unsupported type, an image that
// does not decode, or a file over the read limit. Retrying cannot change that, so
// readers return a complete result instead of an error that keeps the message pending.
export class UnreadableMedia extends Error {}

export function unreadableAttachment(identity, reason, details = {}) {
  return {
    ...identity,
    ...details,
    readable: false,
    reason,
    next_offset: null,
    guidance:
      "Content not inspected and never will be. This read is complete: do not retry it. Mark the message read and mention the attachment as unopened only if it matters.",
  };
}

export async function orUnreadable(read, identity) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof UnreadableMedia)
      return unreadableAttachment(identity, error.message);
    throw error;
  }
}
