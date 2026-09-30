import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export async function authorizationSession() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const received = url.searchParams.get("state") ?? "";
    const valid =
      Buffer.byteLength(received) === Buffer.byteLength(state) &&
      timingSafeEqual(Buffer.from(received), Buffer.from(state));
    if (url.pathname !== "/callback" || !valid) {
      response.writeHead(400).end("Invalid callback");
      return;
    }
    const value = url.searchParams.get("code");
    if (!value) {
      response.writeHead(400).end("Authorization was not completed.");
      rejectCode(new Error("Google authorization was denied"));
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      })
      .end(
        "Authorization received. Return to your terminal for account verification.",
      );
    resolveCode(value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("OAuth callback server could not start");
  const timeout = setTimeout(
    () => rejectCode(new Error("Google authorization timed out")),
    300_000,
  );
  return {
    state,
    verifier,
    code,
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}
