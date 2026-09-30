import { z } from "zod";
import { requestJson, type Http } from "../http.ts";

export class GoogleClient {
  private accessToken = "";
  private expiresAt = 0;
  constructor(
    private readonly credentials: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    },
    private readonly http: Http = requestJson,
  ) {}
  private async token(): Promise<string> {
    if (this.expiresAt > Date.now() + 60_000) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: "refresh_token",
    });
    const result = z
      .object({ access_token: z.string(), expires_in: z.number() })
      .parse(
        await this.http("https://oauth2.googleapis.com/token", {
          method: "POST",
          body,
        }),
      );
    this.accessToken = result.access_token;
    this.expiresAt = Date.now() + result.expires_in * 1000;
    return this.accessToken;
  }
  async request(path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    return this.http(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}
export interface MailClient {
  request(path: string, body?: unknown): Promise<unknown>;
}
export async function verifyMailbox(
  client: MailClient,
  expected: string,
): Promise<string> {
  const profile = z
    .object({ emailAddress: z.email(), historyId: z.string() })
    .parse(await client.request("profile"));
  if (profile.emailAddress.toLowerCase() !== expected.toLowerCase())
    throw new Error(
      "Authenticated Google account differs from configured identity",
    );
  return profile.historyId;
}
