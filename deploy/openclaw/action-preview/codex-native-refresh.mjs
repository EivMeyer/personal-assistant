import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    throw Error("Cannot verify imported Codex login identity");
  }
}
function identity(token) {
  const auth = claims(token)["https://api.openai.com/auth"];
  if (!auth?.chatgpt_account_id || !auth?.chatgpt_user_id)
    throw Error("Imported Codex login lacks account/user identity");
  return [auth.chatgpt_account_id, auth.chatgpt_user_id].join(":");
}
export async function refreshImportedCodexLogin(
  credential,
  {
    read = () =>
      readFile(join(homedir(), ".codex/auth.json"), "utf8").then(JSON.parse),
    refresh,
    now = Date.now,
  } = {},
) {
  if (
    credential.provider !== "openai" ||
    credential.displayName !== "Codex import"
  )
    throw Error("Native refresh is only for explicitly imported Codex logins");
  const expected = identity(credential.access);
  const load = async () => {
    const record = await read();
    const tokens = record.tokens;
    if (
      record.auth_mode !== "chatgpt" ||
      !tokens?.refresh_token ||
      identity(tokens.access_token) !== expected ||
      (credential.accountId && tokens.account_id !== credential.accountId)
    )
      throw Error("Native Codex account changed; sign the assistant in again");
    return tokens;
  };
  let tokens = await load();
  if (
    tokens.access_token === credential.access ||
    claims(tokens.access_token).exp * 1000 <= now() + 60_000
  ) {
    if (!refresh) throw Error("Native Codex refresh is unavailable");
    await refresh();
    tokens = await load();
  }
  const expires = claims(tokens.access_token).exp * 1000;
  if (!Number.isFinite(expires) || expires <= now() + 60_000)
    throw Error("Native Codex login is expired; sign in again");
  return {
    ...credential,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    idToken: tokens.id_token,
    expires,
  };
}
