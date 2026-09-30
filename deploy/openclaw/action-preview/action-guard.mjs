import { ActionStore, digest } from "./action-store.mjs";
import { snapshotSources } from "./source-snapshot.mjs";
export async function reserveAction(
  event,
  ctx,
  config,
  store,
  snapshot = snapshotSources,
) {
  const name = event.toolName.replace(/^mcp__/, "");
  const split = name.indexOf("__");
  const server = name.slice(0, split);
  const tool = name.slice(split + 2);
  const data = await snapshot(server, event.params, config);
  return store.reserve({
    server,
    name: tool,
    args: event.params,
    snapshot: data,
    runId: event.runId ?? ctx.runId,
  });
}
function reportsFailure(value) {
  return (
    value?.success === false || value?.ok === false || value?.status === "error"
  );
}
export function connectorFailed(result) {
  if (result.isError || reportsFailure(result.structuredContent)) return true;
  return (result.content ?? []).some((item) => {
    if (item.type !== "text") return false;
    try {
      return reportsFailure(JSON.parse(item.text));
    } catch {
      return /^Error[:\s]/i.test(item.text.trim());
    }
  });
}
export async function executeGuarded({
  server,
  name,
  args,
  config,
  store,
  invoke,
  snapshot = snapshotSources,
  verify = async () => {},
}) {
  const review = store.claim(server, name, args);
  try {
    await verify({ server }, config);
    const current = await snapshot(server, args, config);
    if (Date.now() > review.expires)
      throw Error(
        "Action review expired during source verification. Nothing executed.",
      );
    if (digest(current) !== digest(review.snapshot))
      throw Error(
        "The source conversation changed while awaiting approval. Nothing executed. Read the updated thread and request a fresh approval.",
      );
  } catch (error) {
    store.finish(review.id, "blocked", { message: error.message });
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  store.executing(review.id);
  const { secretary_sources: _, timeoutMs: _timeout, ...backendArgs } = args;
  try {
    const result = await invoke(name, backendArgs);
    const state = connectorFailed(result) ? "failed" : "completed";
    store.finish(review.id, state, { result });
    return {
      ...result,
      content: [
        ...(result.content ?? []),
        {
          type: "text",
          text:
            "Secretary action " +
            review.id +
            " terminal status: " +
            state +
            ". A durable completion receipt will be delivered to Telegram. Do not repeat this action.",
        },
      ],
    };
  } catch (error) {
    store.finish(review.id, "unknown", {
      message:
        "Connector failed after dispatch; delivery may have occurred. Verify the source before retrying.",
    });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "Outcome unknown. Verify delivery before retrying. " +
            error.message,
        },
      ],
    };
  }
}
export function blockPrematureFinal(event, ctx, store) {
  const runId = event.runId ?? ctx.runId;
  if (!runId || !store.pendingForRun(runId).length) return;
  return {
    action: "revise",
    reason:
      "An action tool is still awaiting approval or execution. Do not abandon its running code-mode cell.",
    retry: {
      idempotencyKey: "secretary-await-action",
      maxAttempts: 3,
      instruction:
        "Use the wait tool on the running exec cell until it returns the terminal result. Never issue the action again. Report the actual outcome, not an assumed pending state.",
    },
  };
}
export { ActionStore };
