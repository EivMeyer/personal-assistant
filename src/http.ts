export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
  ) {
    super(`${service} request failed (${status})`);
  }
}
export type Http = (
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<unknown>;
export const requestJson: Http = async (url, init = {}, timeoutMs = 20_000) => {
  const service = new URL(url).hostname;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Error(`${service} request did not complete`);
  }
  if (!response.ok) throw new ApiError(service, response.status);
  try {
    return await response.json();
  } catch {
    throw new Error(`${service} returned an invalid response`);
  }
};
