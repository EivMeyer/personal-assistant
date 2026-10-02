import type { Http } from "../http.ts";
class DiscordHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Discord request failed (${status})`);
    this.status = status;
  }
}
export class DiscordRateLimit extends DiscordHttpError {
  readonly retryAfterMs: number;
  constructor(delay: number) {
    super(429);
    this.retryAfterMs = delay;
  }
}
export function discordTransport(
  request: typeof fetch = fetch,
  now = Date.now,
): Http {
  let resumeAt = 0;
  return async (url, init = {}) => {
    if (now() < resumeAt) throw new DiscordRateLimit(resumeAt - now());
    let response: Response;
    try {
      response = await request(url, {
        ...init,
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
    } catch {
      throw Error("Discord request did not complete");
    }
    if (response.status === 429) {
      const result = (await response.json()) as { retry_after?: unknown };
      const delay =
        typeof result.retry_after === "number" &&
        Number.isFinite(result.retry_after)
          ? Math.max(1000, result.retry_after * 1000)
          : 60000;
      resumeAt = now() + delay;
      throw new DiscordRateLimit(delay);
    }
    if (!response.ok) throw new DiscordHttpError(response.status);
    return response.json();
  };
}
export const discordHttp = discordTransport();
