import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { patchPackageInstall } from "./package-install-patch.mjs";
const original = `async function resolveUpdateInstallKind(root, options = {}) {
 options.signal?.throwIfAborted();
\tif (!root) return "unknown";
\tconst result = await runUpdateGitCommand(root, ["rev-parse", "--show-toplevel"], {
 ...options, timeoutMs: options.timeoutMs ?? 1200000 });
 if (result.code === 0 && result.stdout === root) return "git";
 return await readPackageName(root) === PUBLIC_NPM_PACKAGE_NAME ? "package" : "unknown";
}`;
test("npm installs do not spawn Git; Git checkouts retain their existing detection", async () => {
  let gitCalls = 0;
  let git = false;
  const ctx = vm.createContext({
    path,
    PUBLIC_NPM_PACKAGE_NAME: "openclaw",
    exists: async () => git,
    readPackageName: async () => "openclaw",
    runUpdateGitCommand: async (root) => {
      gitCalls++;
      return { code: 0, stdout: root };
    },
  });
  vm.runInContext(patchPackageInstall(original), ctx);
  assert.equal(await ctx.resolveUpdateInstallKind("/npm/openclaw"), "package");
  assert.equal(gitCalls, 0);
  git = true;
  assert.equal(await ctx.resolveUpdateInstallKind("/src/openclaw"), "git");
  assert.equal(gitCalls, 1);
  assert.equal(await ctx.resolveUpdateInstallKind(null), "unknown");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    ctx.resolveUpdateInstallKind("/npm/openclaw", { signal: abort.signal }),
  );
});
test("package patch refuses drift and is idempotent", () => {
  const patched = patchPackageInstall(original);
  assert.equal(patchPackageInstall(patched), patched);
  assert.throws(() => patchPackageInstall("changed"), /Unexpected/);
});
