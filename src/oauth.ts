import { createHash } from "node:crypto";
import { authorizationSession } from "./oauth-session.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { secret, type Config } from "./config.ts";
import { requestJson } from "./http.ts";
import { GoogleClient, verifyMailbox } from "./adapters/google-client.ts";

export async function authorizeGoogle(
  config: Config,
  accountId: string,
  output: string,
): Promise<void> {
  const settings = config.gmail;
  const account = settings?.accounts.find((entry) => entry.id === accountId);
  if (!settings || !account) throw new Error("Unknown Gmail account");
  const clientId = secret(settings.clientIdEnv);
  const clientSecret = secret(settings.clientSecretEnv);
  const session = await authorizationSession();
  try {
    const scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
    if (account.id === settings.senderAccount)
      scopes.push("https://www.googleapis.com/auth/gmail.send");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: session.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: session.state,
      code_challenge: createHash("sha256")
        .update(session.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    console.log(
      `Open this Google authorization URL in your browser. Select the configured ${account.id} account:\nhttps://accounts.google.com/o/oauth2/v2/auth?${query}`,
    );
    const code = await session.code;
    const tokens = z.object({ refresh_token: z.string() }).parse(
      await requestJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          code_verifier: session.verifier,
          redirect_uri: session.redirectUri,
          grant_type: "authorization_code",
        }),
      }),
    );
    const client = new GoogleClient({
      clientId,
      clientSecret,
      refreshToken: tokens.refresh_token,
    });
    await verifyMailbox(client, account.email);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(
      output,
      `${account.refreshTokenEnv}=${tokens.refresh_token}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Verified account. Refresh token saved to the specified file with mode 0600. It was not printed.",
    );
  } finally {
    session.close();
  }
}
