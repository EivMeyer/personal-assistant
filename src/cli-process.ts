import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliRequest {
  executable: string;
  args: string[];
  input?: string;
  timeoutMs: number;
}
export type CliRunner = (request: CliRequest) => Promise<string>;

// Deliberate allowlist: source credentials, provider overrides, hooks, and Node
// injection variables from the service environment must never reach the CLI.
export function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

export const runCli: CliRunner = async (request) => {
  const cwd = await mkdtemp(join(tmpdir(), "personal-assistant-model-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd,
        env: cliEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure = "";
      const stop = (reason: string) => {
        failure ||= reason;
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // A process that already exited is handled by close below.
        }
      };
      const timer = setTimeout(
        () => stop("Model CLI timed out"),
        request.timeoutMs,
      );
      const count = (chunk: Buffer) => {
        size += chunk.length;
        if (size > 512_000) stop("Model CLI exceeded output limit");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        count(chunk);
        if (!failure) chunks.push(chunk);
      });
      // Provider errors can echo messages and tokens; never expose stderr.
      child.stderr.on("data", count);
      child.on("error", () => {
        failure ||= "Model CLI could not start";
      });
      child.stdin.on("error", () => {
        failure ||= "Model CLI input failed";
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) {
          reject(
            new Error(
              failure || "Model CLI failed; check login or usage limits",
            ),
          );
        } else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.end(request.input ?? "");
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
