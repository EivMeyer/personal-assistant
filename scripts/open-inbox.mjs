#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const token = readFileSync(
  join(homedir(), ".local/share/secretary-inbox/access-token"),
  "utf8",
).trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw Error("Inbox access token is invalid.");
execFileSync("/usr/bin/open", ["http://127.0.0.1:18792/#token=" + token]);
