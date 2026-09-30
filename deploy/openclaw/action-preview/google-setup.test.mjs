import test from "node:test";
import assert from "node:assert/strict";
import { authorizationUrl, callbackCode } from "./google-setup.mjs";
test("OAuth is company-scoped, uses PKCE and rejects forged callbacks", () => {
  const u = authorizationUrl(
    { client_id: "fixture" },
    {
      redirect: "http://127.0.0.1:1234/callback",
      state: "expected",
      hash: "challenge",
    },
  );
  assert.equal(u.hostname, "accounts.google.com");
  assert.equal(u.searchParams.get("login_hint"), "owner@theopenengine.com");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("scope"), /calendar.readonly/);
  assert.doesNotMatch(u.searchParams.get("scope"), /gmail/);
  assert.equal(
    callbackCode(
      new URL("http://127.0.0.1/callback?state=expected&code=fixture"),
      "expected",
    ),
    "fixture",
  );
  assert.throws(
    () =>
      callbackCode(
        new URL("http://127.0.0.1/callback?state=forged&code=x"),
        "expected",
      ),
    /state/,
  );
  assert.throws(
    () =>
      callbackCode(
        new URL("http://127.0.0.1/other?state=expected&code=x"),
        "expected",
      ),
    /path/,
  );
  assert.throws(
    () =>
      callbackCode(
        new URL("http://127.0.0.1/callback?state=expected&error=access_denied"),
        "expected",
      ),
    /not granted/,
  );
});
