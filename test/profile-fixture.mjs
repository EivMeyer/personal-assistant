import { fileURLToPath } from "node:url";
// Tests never load the developer's live account identities or runtime profile.
process.env.SECRETARY_OWNER_FILE = fileURLToPath(
  new URL("./fixtures/owner-profile.json", import.meta.url),
);
