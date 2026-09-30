import { secret, type Config } from "./config.ts";
import { type Planner } from "./domain.ts";
import { OpenAIPlanner } from "./planner.ts";
import { ClaudePlanner } from "./claude-planner.ts";

export function buildPlanner(config: Config): Planner {
  if (config.modelProvider === "claude-cli") {
    return new ClaudePlanner({
      executable: config.claudeCliPath,
      model: config.model,
      trustedContext: config.trustedContext,
      timeoutMs: config.modelTimeoutMs,
    });
  }
  return new OpenAIPlanner({
    apiKey: secret(config.openaiKeyEnv),
    model: config.model,
    trustedContext: config.trustedContext,
  });
}

export async function verifyPlanner(config: Config): Promise<void> {
  const planner = buildPlanner(config);
  if (planner instanceof ClaudePlanner) await planner.verify();
}
