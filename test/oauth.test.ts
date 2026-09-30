import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizationSession } from "../src/oauth-session.ts";

test("OAuth callback rejects incorrect and multibyte state without crashing", async (t) => {
  const session = await authorizationSession();
  t.after(session.close);
  const invalid = await fetch(
    `${session.redirectUri}?state=${encodeURIComponent("é".repeat(session.state.length))}&code=wrong`,
  );
  assert.equal(invalid.status, 400);
  const valid = await fetch(
    `${session.redirectUri}?state=${session.state}&code=approved-code`,
  );
  assert.equal(valid.status, 200);
  assert.equal(await session.code, "approved-code");
});
