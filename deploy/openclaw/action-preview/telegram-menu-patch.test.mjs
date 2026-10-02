import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { patchTelegramMenu } from "./telegram-menu-patch.mjs";

test("gateway Mini App gets a distinct command without changing its access control or handler", () => {
  const source = `function createTelegramMiniAppDashboardCommand(api, launchTickets) {
\treturn {
\t\tname: "dashboard",
    requireAuth: true,
    exposeSenderIsOwner: true,
    channels: ["telegram"],
    handler: api.handler
  };
}`;
  const ctx = vm.createContext({});
  const patched = patchTelegramMenu(source);
  vm.runInContext(patched, ctx);
  const handler = () => {};
  const command = ctx.createTelegramMiniAppDashboardCommand({ handler }, {});
  assert.equal(command.name, "gateway_dashboard");
  assert.equal(command.requireAuth, true);
  assert.equal(command.exposeSenderIsOwner, true);
  assert.equal(command.handler, handler);
  assert.equal(command.channels.join(), "telegram");
  assert.equal(patchTelegramMenu(patched), patched);
  assert.throws(() => patchTelegramMenu("changed"), /Unexpected/);
});
