import test from "node:test";
import assert from "node:assert/strict";
import { githubPath, githubRead } from "./github-read.mjs";
const settings = {
  allowedOwners: ["example"],
  login: "owner",
  ghPath: "/usr/bin/gh",
};
test("GitHub reader restricts scope, operations, and path traversal", () => {
  for (const input of [
    { repo: "other/repo", resource: "pull_request", number: 1 },
    { repo: "example/..", resource: "pull_request", number: 1 },
    { repo: "example/.", resource: "pull_request", number: 1 },
    { repo: "example/repo", resource: "delete", number: 1 },
    { repo: "example/repo", resource: "file", path: "../secret", ref: "main" },
    {
      repo: "example/repo",
      resource: "file",
      path: "file",
      ref: "main",
      method: "POST",
    },
  ])
    assert.throws(() => githubPath(input, settings));
  assert.equal(
    githubPath(
      {
        repo: "example/repo",
        resource: "file",
        path: "a b.js",
        ref: "feature/x",
      },
      settings,
    ).endpoint,
    "repos/example/repo/contents/a%20b.js?ref=feature%2Fx",
  );
});
test("GitHub reader verifies owner, uses GET only and exposes pagination", async () => {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify(
        args.at(-1) === "user"
          ? { login: "owner" }
          : Array(100).fill({ filename: "file" }),
      ),
    };
  };
  const result = await githubRead(
    { repo: "example/repo", resource: "pull_request_files", number: 313 },
    settings,
    run,
  );
  assert.equal(result.next_page, 2);
  assert.ok(calls.every((args) => args[4] === "GET"));
  await assert.rejects(
    githubRead(
      { repo: "example/repo", resource: "pull_request", number: 1 },
      settings,
      async () => ({ stdout: '{"login":"wrong"}' }),
    ),
    /differs/,
  );
});
