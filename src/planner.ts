import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  assessmentSchema,
  type Assessment,
  type Conversation,
  type Planner,
} from "./domain.ts";

import { instructions } from "./planner-prompt.ts";

export class OpenAIPlanner implements Planner {
  private readonly client: OpenAI;
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      trustedContext: string;
    },
  ) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: 45_000,
    });
  }
  async assess(
    context: Conversation,
    correction = "",
    previous?: Assessment,
  ): Promise<Assessment> {
    const response = await this.client.responses.parse({
      model: this.options.model,
      store: false,
      max_output_tokens: 8192,
      instructions: `${instructions}\nOwner-provided standing context:\n${this.options.trustedContext}`,
      input: JSON.stringify({
        untrustedConversation: context,
        ownerCorrection: correction,
        previousDraft: previous,
      }),
      text: { format: zodTextFormat(assessmentSchema, "assessment") },
    });
    if (!response.output_parsed)
      throw new Error("Model did not return a complete assessment");
    const result = assessmentSchema.parse(response.output_parsed);
    if (result.draft?.includes("\u2014"))
      result.draft = result.draft.replaceAll("\u2014", ",");
    return result;
  }
}
