import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const profileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\r\n]+$/),
    workEmail: z
      .email()
      .refine(
        (s) => s.endsWith("@theopenengine.com"),
        "Use your own company email",
      ),
    telegramUserId: z.string().regex(/^[1-9][0-9]{4,19}$/),
    timezone: z.string().refine((s) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: s });
        return true;
      } catch {
        return false;
      }
    }),
    slackUserId: z
      .string()
      .regex(/^U[A-Z0-9]+$/)
      .optional(),
    slackTeamId: z
      .string()
      .regex(/^T[A-Z0-9]+$/)
      .optional(),
    whatsappPhone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .optional(),
    whatsappStoreDir: z.string().startsWith("/").optional(),
  })
  .strict()
  .refine(
    (p) => Boolean(p.slackUserId) === Boolean(p.slackTeamId),
    "Provide both Slack IDs or neither",
  );
let cached;
export function ownerProfile() {
  if (!cached) {
    const path =
      process.env.SECRETARY_OWNER_FILE ??
      join(homedir(), ".local/share/secretary/profile.json");
    try {
      cached = Object.freeze(
        profileSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
      );
    } catch {
      throw Error("Owner profile is missing or invalid. See docs/openclaw.md.");
    }
  }
  return cached;
}
export function whatsappStore() {
  return (
    ownerProfile().whatsappStoreDir ??
    join(homedir(), "repos/whatsapp-mcp/whatsapp-bridge/store")
  );
}
