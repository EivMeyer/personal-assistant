import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const emailAccount = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  email: z.email(),
  refreshTokenEnv: z.string().min(1),
});
export const configSchema = z
  .object({
    mode: z.enum(["preview", "live"]).default("preview"),
    dataDir: z.string().default("~/.local/share/personal-assistant"),
    model: z.string().min(1),
    modelProvider: z.enum(["openai", "claude-cli"]).default("openai"),
    claudeCliPath: z.string().default("~/.local/bin/claude"),
    modelTimeoutMs: z.number().int().min(1000).max(120_000).default(90_000),
    openaiKeyEnv: z.string().default("OPENAI_API_KEY"),
    telegram: z.object({
      tokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
      userId: z.number().int().positive(),
      chatId: z.number().int().positive(),
    }),
    gmail: z
      .object({
        clientIdEnv: z.string().default("GOOGLE_CLIENT_ID"),
        clientSecretEnv: z.string().default("GOOGLE_CLIENT_SECRET"),
        accounts: z.array(emailAccount).min(1),
        senderAccount: z.string(),
      })
      .optional(),
    whatsapp: z
      .object({
        messagesDb: z.string(),
        sessionDb: z.string(),
        selfJid: z.string().regex(/^\d+@s\.whatsapp\.net$/),
        bridgeUrl: z.url().default("http://127.0.0.1:8080"),
        tokenEnv: z.string().optional(),
        allowGroups: z.boolean().default(false),
      })
      .optional(),
    mutedThreads: z.array(z.string()).default([]),
    trustedContext: z.string().max(20_000).default(""),
    maxContextChars: z.number().int().min(2000).max(500_000).default(80_000),
    maxAssessmentsPerDay: z.number().int().min(1).max(10000).default(100),
    approvalHours: z.number().positive().max(168).default(24),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type GmailAccount = z.infer<typeof emailAccount>;
export function expandPath(path: string): string {
  const expanded = path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : path;
  if (!isAbsolute(expanded))
    throw new Error("Configuration paths must be absolute or start with ~/");
  return expanded;
}
export function loadConfig(path: string): Config {
  const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!config.gmail && !config.whatsapp)
    throw new Error("At least one incoming source is required");
  if (config.gmail) validateGmail(config.gmail);
  config.dataDir = expandPath(config.dataDir);
  config.claudeCliPath = expandPath(config.claudeCliPath);
  if (config.whatsapp) {
    config.whatsapp.messagesDb = expandPath(config.whatsapp.messagesDb);
    config.whatsapp.sessionDb = expandPath(config.whatsapp.sessionDb);
    const url = new URL(config.whatsapp.bridgeUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("WhatsApp bridge must use local loopback HTTP");
    }
  }
  return config;
}
function validateGmail(config: NonNullable<Config["gmail"]>): void {
  if (
    new Set(config.accounts.map((account) => account.id)).size !==
    config.accounts.length
  )
    throw new Error("Duplicate account ID");
  const sender = config.accounts.find(
    (account) => account.id === config.senderAccount,
  );
  if (sender?.email !== "eivind@theopenengine.com")
    throw new Error("Sender account must be the company mailbox");
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
