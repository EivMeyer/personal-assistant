import { z } from "zod";
import {
  assessmentSchema,
  type Assessment,
  type Conversation,
  type Planner,
} from "./domain.ts";
import { instructions } from "./planner-prompt.ts";
import { runCli, type CliRunner } from "./cli-process.ts";

export class ClaudePlanner implements Planner {
  constructor(
    private readonly options: {
      executable: string;
      model: string;
      trustedContext: string;
      timeoutMs: number;
    },
    private readonly run: CliRunner = runCli,
  ) {}

  async verify(): Promise<void> {
    const raw = await this.run({
      executable: this.options.executable,
      args: ["auth", "status"],
      timeoutMs: 15_000,
    });
    try {
      z.object({
        loggedIn: z.literal(true),
        authMethod: z.literal("claude.ai"),
      }).parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "Claude Code needs an active subscription login; run claude auth login",
      );
    }
  }

  async assess(
    context: Conversation,
    correction = "",
    previous?: Assessment,
  ): Promise<Assessment> {
    const raw = await this.run({
      executable: this.options.executable,
      args: [
        "-p",
        "--safe-mode",
        "--restricted",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false}',
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(z.toJSONSchema(assessmentSchema, { target: "draft-7" })),
        "--system-prompt",
        instructions,
        "--model",
        this.options.model,
      ],
      input: JSON.stringify({
        untrustedConversation: context,
        ownerCorrection: correction,
        ownerStandingContext: this.options.trustedContext,
        previousDraft: previous,
      }),
      timeoutMs: this.options.timeoutMs,
    });
    try {
      const envelope = z
        .object({
          type: z.literal("result"),
          subtype: z.literal("success"),
          is_error: z.literal(false),
          structured_output: assessmentSchema,
        })
        .parse(JSON.parse(raw));
      const result = envelope.structured_output;
      if (result.draft) result.draft = result.draft.replaceAll("\u2014", ",");
      return result;
    } catch {
      // Never include raw provider output in logs or user-visible errors.
      throw new Error("Claude Code did not return a valid complete assessment");
    }
  }
}
