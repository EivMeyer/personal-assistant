import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COMPANY_EMAIL,
  GOOGLE_SCOPES,
  GOOGLE_ACTION_SCOPES,
  googleJson,
  verifyCompany,
} from "./google-auth.mjs";

export function authorizationUrl(keys, challenge) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const args = {
    client_id: keys.client_id,
    redirect_uri: challenge.redirect,
    response_type: "code",
    scope: (challenge.scopes ?? GOOGLE_SCOPES).join(" "),
    access_type: "offline",
    prompt: "consent",
    login_hint: COMPANY_EMAIL,
    state: challenge.state,
    code_challenge: challenge.hash,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(args))
    url.searchParams.set(key, value);
  return url;
}
export function callbackCode(url, expected) {
  if (
    url.pathname !== "/callback" ||
    url.searchParams.get("state") !== expected
  )
    throw Error("Invalid OAuth callback state or path");
  if (url.searchParams.has("error"))
    throw Error("Google authorization was not granted");
  const code = url.searchParams.get("code");
  if (!code) throw Error("Missing Google authorization code");
  return code;
}
async function exchange(keys, challenge, code) {
  const token = await googleJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      code,
      code_verifier: challenge.verifier,
      redirect_uri: challenge.redirect,
      grant_type: "authorization_code",
    }),
  });
  if (!token.refresh_token || !token.access_token)
    throw Error("Offline Google access was not granted");
  const granted = new Set((token.scope ?? "").split(" "));
  for (const scope of (challenge.scopes ?? GOOGLE_SCOPES).filter((s) =>
    s.startsWith("https://"),
  ))
    if (!granted.has(scope))
      throw Error("Required Google scope was not granted");
  const profile = await googleJson(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: "Bearer " + token.access_token } },
  );
  verifyCompany(profile);
  return {
    email: COMPANY_EMAIL,
    refresh_token: token.refresh_token,
    scope: token.scope,
  };
}
async function persist(settings, token) {
  await mkdir(dirname(settings.tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(settings.tokenPath, JSON.stringify(token, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export async function setupGoogle(settings) {
  const keys = JSON.parse(
    await readFile(settings.clientPath, "utf8"),
  ).installed;
  if (!keys?.client_id || !keys.client_secret)
    throw Error("Expected an installed-app OAuth client");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = {
    scopes: settings.mode === "actions" ? GOOGLE_ACTION_SCOPES : GOOGLE_SCOPES,
    verifier,
    state: randomBytes(32).toString("hex"),
    hash: createHash("sha256").update(verifier).digest("base64url"),
  };
  let processing = false;
  const server = createServer(async (req, res) => {
    const incoming = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (incoming.pathname === "/start") {
      res
        .writeHead(302, {
          Location: authorizationUrl(keys, challenge).href,
          "Cache-Control": "no-store",
        })
        .end();
      return;
    }
    if (processing) {
      res.writeHead(409).end("Authorization already in progress");
      return;
    }
    try {
      const code = callbackCode(incoming, challenge.state);
      processing = true;
      await persist(settings, await exchange(keys, challenge, code));
      res
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        })
        .end("Company Google access saved. You may close this tab.");
      console.log(
        "Company Google access saved; no calendar or Drive changes performed.",
      );
      clearTimeout(timer);
      server.close();
    } catch (error) {
      res
        .writeHead(400, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        })
        .end(error.message);
      processing = false;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  challenge.redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const timer = setTimeout(
    () => {
      console.error("Google setup expired; no access activated");
      server.close();
    },
    15 * 60 * 1000,
  );
  console.log(
    `Open http://127.0.0.1:${server.address().port}/start to authorize company Calendar/Drive ${settings.mode === "actions" ? "guarded writes" : "reads"}.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await setupGoogle(JSON.parse(await readFile(process.argv[2], "utf8")));
