export function addSources(result) {
  return {
    ...result,
    tools: result.tools.map((tool) => ({
      ...tool,
      description:
        tool.description +
        " Include secretary_sources for every source conversation informing the action. Source state is rechecked after approval. Never retry an unknown result.",
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          timeoutMs: {
            type: "integer",
            const: 210000,
            default: 210000,
            description:
              "Required outer budget covering owner review and connector completion. Always pass 210000.",
          },
          secretary_sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: {
                  type: "string",
                  enum: [
                    "gmail-work",
                    "gmail-personal",
                    "whatsapp",
                    "slack",
                    "google-event",
                    "google-document",
                  ],
                },
                thread: { type: "string" },
              },
              required: ["source", "thread"],
              additionalProperties: false,
            },
            description:
              "All source references; google-event thread is a primary event ID; google-document thread is a Doc ID. [] only for a new outbound request.",
          },
        },
        required: [
          ...new Set([
            ...(tool.inputSchema.required ?? []),
            "secretary_sources",
            "timeoutMs",
          ]),
        ],
      },
    })),
  };
}
