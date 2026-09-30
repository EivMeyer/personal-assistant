import { join } from "node:path";
import type { Config } from "./config.ts";
import { secret } from "./config.ts";
import { openDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { GoogleClient } from "./adapters/google-client.ts";
import { GmailSource } from "./adapters/gmail.ts";
import { WhatsAppSource } from "./adapters/whatsapp.ts";
import type { Source } from "./domain.ts";

export function buildSources(
  config: Config,
  store: Store,
): Map<string, Source> {
  const sources = new Map<string, Source>();
  if (config.gmail) addGmail(config.gmail, store, sources);
  if (config.whatsapp) {
    const source = new WhatsAppSource(
      {
        ...config.whatsapp,
        token: config.whatsapp.tokenEnv
          ? secret(config.whatsapp.tokenEnv)
          : undefined,
      },
      store,
    );
    sources.set(source.id, source);
  }
  return sources;
}
function addGmail(
  config: NonNullable<Config["gmail"]>,
  store: Store,
  sources: Map<string, Source>,
): void {
  const accounts = config.accounts.map((account) => ({
    ...account,
    client: new GoogleClient({
      clientId: secret(config.clientIdEnv),
      clientSecret: secret(config.clientSecretEnv),
      refreshToken: secret(account.refreshTokenEnv),
    }),
  }));
  const sender = accounts.find(
    (account) => account.id === config.senderAccount,
  );
  if (!sender) throw new Error("Sending account is missing");
  const ownEmails = accounts.map((account) => account.email.toLowerCase());
  for (const account of accounts) {
    const source = new GmailSource({ ...account, sender, ownEmails }, store);
    sources.set(source.id, source);
  }
}
export function buildStore(config: Config): Store {
  return new Store(openDatabase(join(config.dataDir, "assistant.db")));
}
