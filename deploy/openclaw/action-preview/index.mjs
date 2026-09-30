import { ownerProfile, whatsappStore } from "./owner-profile.mjs";
import { registerIncomingNotices } from "./incoming-notices.mjs";
import { actionPreviewText } from "./approval-copy.mjs";
import { slackDestination } from "./slack-destination.mjs";
import { verifySlackIdentity } from "./slack-auth.mjs";
import {
  ActionStore,
  reserveAction,
  blockPrematureFinal,
} from "./action-guard.mjs";
import {
  registerReceiptDelivery,
  registerAbandonedRunStatus,
} from "./receipt-delivery.mjs";
import { registerHealthAlerts } from "./health-alerts.mjs";
import { registerIncomingContext } from "./incoming-context.mjs";
import { registerConversationContext } from "./conversation-context.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { verifyGoogleActionIdentity } from "./google-action-sources.mjs";
const COMPANY = ownerProfile().workEmail;
const ACTIONS = new Set([
  "google-work-actions",
  "gmail-work-actions",
  "whatsapp-actions",
  "slack-actions",
]);
function assertOwner(test, ctx) {
  if (
    !test &&
    (ctx.requester?.channel !== "telegram" ||
      ctx.requester?.senderId !== ownerProfile().telegramUserId ||
      ctx.requester?.senderIsOwner !== true)
  ) {
    throw new Error(
      "External actions require a current request from the Telegram owner. Background checks may prepare proposals only.",
    );
  }
}
function assertNativeApproval(server, config) {
  if (
    config.mcp?.servers?.[server]?.codex?.defaultToolsApprovalMode !== "prompt"
  ) {
    throw new Error(
      "The action connector must require native approval for every call.",
    );
  }
}
function validateAction(server, test, params, ctx, config) {
  assertOwner(test, ctx);
  assertNativeApproval(server, config);
  if (
    !test &&
    !config.mcp.servers[server].args?.some((arg) =>
      arg.endsWith("/guarded-mcp.mjs"),
    )
  )
    throw new Error(
      "Action connector lacks the post-approval execution guard.",
    );
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error("Invalid action arguments.");
  if (
    server === "gmail-work-actions" &&
    params.from &&
    params.from !== COMPANY
  ) {
    throw new Error("Outgoing email must use the company account.");
  }
}

export function planPreview(event, ctx, config, destination) {
  const name = event.toolName.replace(/^mcp__/, "");
  const separator = name.indexOf("__");
  const server = name.slice(0, separator);
  if (!ACTIONS.has(server) && server !== "setup-approval-fixture") return null;
  const test = server === "setup-approval-fixture";
  const params = event.params;
  validateAction(server, test, params, ctx, config);
  const payload = JSON.stringify(params, null, 2);
  if (payload.length > 24000)
    throw new Error(
      "This action is too large for complete Telegram review; prepare a smaller action.",
    );
  const id = createHash("sha256")
    .update(name + "\n" + payload)
    .digest("hex")
    .slice(0, 12);
  const identities = {
    "gmail-work-actions": COMPANY,
    "google-work-actions": COMPANY,
    "whatsapp-actions": ownerProfile().whatsappPhone,
    "slack-actions": ownerProfile().name + " · The Open Engine",
    "setup-approval-fixture": "Local installation test, no external message",
  };
  const identity = identities[server];
  const text = actionPreviewText({
    tool: name.slice(separator + 2),
    params,
    identity,
    destination,
  });
  const chunks = [];
  const chars = Array.from(text);
  for (let offset = 0; offset < chars.length; offset += 3000)
    chunks.push(chars.slice(offset, offset + 3000).join(""));
  return { server, id, chunks, test };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      "Account or preview service returned HTTP " + response.status,
    );
  return response.json();
}
async function verifyGmail(config) {
  const env = config.mcp.servers["gmail-work-actions"].env;
  const keys = JSON.parse(
    await readFile(env.GMAIL_OAUTH_PATH, "utf8"),
  ).installed;
  const credentials = JSON.parse(
    await readFile(env.GMAIL_CREDENTIALS_PATH, "utf8"),
  );
  const auth = await jsonRequest("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (typeof auth.access_token !== "string")
    throw new Error("Company email authentication failed.");
  const profile = await jsonRequest(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: { Authorization: "Bearer " + auth.access_token },
    },
  );
  if (profile.emailAddress !== COMPANY)
    throw new Error("Company email sender could not be verified.");
}
async function verifyWhatsApp() {
  const db = new DatabaseSync(whatsappStore() + "/whatsapp.db", {
    readOnly: true,
  });
  try {
    const rows = db.prepare("SELECT jid FROM whatsmeow_device").all();
    if (
      rows.length !== 1 ||
      rows[0].jid.replace(/:\d+@/, "@") !==
        ownerProfile().whatsappPhone?.slice(1) + "@s.whatsapp.net"
    ) {
      throw new Error("WhatsApp sending identity could not be verified.");
    }
  } finally {
    db.close();
  }
}
export async function verifyIdentity(plan, config) {
  const check = {
    "google-work-actions": verifyGoogleActionIdentity,
    "gmail-work-actions": verifyGmail,
    "whatsapp-actions": verifyWhatsApp,
    "slack-actions": verifySlackIdentity,
  }[plan.server];
  if (check) await check(config);
}
async function deliverPreview(plan, config, dependencies) {
  const token = (
    await (dependencies.readToken ?? readFile)(
      config.channels.telegram.tokenFile,
      "utf8",
    )
  ).trim();
  for (let i = 0; i < plan.chunks.length; i++) {
    const result = await (dependencies.jsonRequest ?? jsonRequest)(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: ownerProfile().telegramUserId,
          text:
            (plan.chunks.length > 1
              ? "Part " + (i + 1) + " of " + plan.chunks.length + "\n"
              : "") + plan.chunks[i],
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    if (!result.ok)
      throw new Error("Telegram did not confirm the complete action preview.");
  }
}
export async function evaluateAction(event, ctx, config, dependencies = {}) {
  try {
    let plan = planPreview(event, ctx, config);
    if (!plan) return;
    await (dependencies.verifyIdentity ?? verifyIdentity)(plan, config);
    if (plan.server === "slack-actions") {
      const destination = await (
        dependencies.slackDestination ?? slackDestination
      )(event.params, config);
      plan = planPreview(event, ctx, config, destination);
    }
    await deliverPreview(plan, config, dependencies);
    await dependencies.reserve?.(event, ctx, config);
    // Native MCP prompt mode owns the one-shot execution gate, after this preview.
    return;
  } catch (error) {
    return {
      block: true,
      blockReason:
        error instanceof Error ? error.message : "Action review failed.",
    };
  }
}
export default {
  id: "secretary-action-preview",
  name: "Secretary action preview",
  register(api) {
    registerConversationContext(api);
    registerHealthAlerts(api);
    registerIncomingContext(api);
    registerIncomingNotices(api);
    const store = new ActionStore();
    registerReceiptDelivery(api, store);
    registerAbandonedRunStatus(api, store);
    api.on("before_agent_finalize", (event, ctx) =>
      blockPrematureFinal(event, ctx, store),
    );
    api.registerTrustedToolPolicy({
      id: "review-external-actions",
      description:
        "Verify sending identity and show exact action arguments before native per-call approval.",
      evaluate: (event, ctx) =>
        evaluateAction(event, ctx, api.config, {
          reserve: (event, ctx, config) =>
            reserveAction(event, ctx, config, store),
        }),
    });
  },
};
