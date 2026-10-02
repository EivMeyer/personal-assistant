// Fictional email action shared by the review tests. Never a real recipient.
export const fixtureAction = {
  server: "gmail-work-actions",
  tool: "send_email",
  args: {
    to: ["recipient@example.com"],
    subject: "Fixture",
    body: "Fictional message",
    secretary_sources: [],
    timeoutMs: 210000,
  },
};
