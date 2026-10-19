import test from "node:test";
import assert from "node:assert/strict";
import { refreshImportedCodexLogin } from "./codex-native-refresh.mjs";
import { patchCodexNativeRefresh } from "./codex-native-refresh-patch.mjs";
const token = (exp, user = "user-a") =>
  "header." +
  Buffer.from(
    JSON.stringify({
      exp,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-a",
        chatgpt_user_id: user,
      },
    }),
  ).toString("base64url") +
  ".signature";
const credential = {
  provider: "openai",
  displayName: "Codex import",
  accountId: "account-a",
  access: token(1),
  refresh: "spent-refresh",
};
const record = (access) => ({
  auth_mode: "chatgpt",
  tokens: {
    access_token: access,
    refresh_token: "native-owned-refresh",
    account_id: "account-a",
  },
});
test("adopts the same account's renewed native login without spending a copied refresh token", async () => {
  const result = await refreshImportedCodexLogin(credential, {
    read: async () => record(token(1000)),
    now: () => 1000,
    refresh: () => assert.fail("fresh native credentials do not need renewal"),
  });
  assert.equal(result.access, token(1000));
  assert.equal(result.expires, 1000000);
});
test("expired native credentials are renewed by their native owner and read back", async () => {
  let current = record(credential.access),
    calls = 0;
  const result = await refreshImportedCodexLogin(credential, {
    now: () => 1000,
    read: async () => current,
    refresh: async () => {
      calls++;
      current = record(token(1000));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.access, token(1000));
});
test("account changes, missing credentials and failed renewal fail closed", async () => {
  for (const read of [
    async () => record(token(1000, "other-user")),
    async () => ({}),
  ])
    await assert.rejects(
      refreshImportedCodexLogin(credential, { read }),
      /identity|account/i,
    );
  await assert.rejects(
    refreshImportedCodexLogin(credential, {
      now: () => 1000,
      read: async () => record(credential.access),
      refresh: async () => {},
    }),
    /expired/,
  );
  await assert.rejects(
    refreshImportedCodexLogin(credential, {
      read: async () => record(credential.access),
      refresh: async () => {
        throw Error("offline");
      },
    }),
    /offline/,
  );
});
test("native identity is checked again after renewal", async () => {
  let current = record(credential.access);
  await assert.rejects(
    refreshImportedCodexLogin(credential, {
      read: async () => current,
      now: () => 1000,
      refresh: async () => {
        current = record(token(1000, "other-user"));
      },
    }),
    /account/,
  );
});
test("reviewed patch is idempotent and refuses source drift", () => {
  const source =
    "async function refreshOpenAICodexOAuthCredential(cred) { return upstream(cred); }";
  const patched = patchCodexNativeRefresh(
    source,
    "file:///helper.mjs",
    "file:///client.mjs",
    "/codex",
  );
  assert.match(patched, /account\/read/);
  assert.match(patched, /closeAndWait/);
  assert.equal(patchCodexNativeRefresh(patched), patched);
  assert.throws(() => patchCodexNativeRefresh("changed"), /Unexpected/);
});
