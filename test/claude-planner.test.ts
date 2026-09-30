import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { ClaudePlanner } from "../src/claude-planner.ts";
import { runCli, cliEnvironment, type CliRequest } from "../src/cli-process.ts";
import { conversation } from "./helpers.ts";

const options = {
  executable: "/unused/claude",
  model: "sonnet",
  trustedContext: "Private standing preference",
  timeoutMs: 1000,
};
const assessment = {
  decision: "ask",
  reason: "A reply is needed",
  question: null,
  draft: "An update soon.",
};
const success = (value: unknown) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: value,
  });

test("CLI transports private content only on stdin and removes action capabilities", async () => {
  let request: CliRequest | undefined;
  const planner = new ClaudePlanner(options, async (r) => {
    request = r;
    return success(assessment);
  });
  assert.deepEqual(
    await planner.assess(conversation(), "private correction"),
    assessment,
  );
  assert.ok(request);
  const schema = JSON.parse(
    request.args[request.args.indexOf("--json-schema") + 1]!,
  );
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  const input = JSON.parse(request.input!);
  assert.equal(input.ownerCorrection, "private correction");
  assert.equal(input.ownerStandingContext, options.trustedContext);
  assert.deepEqual(input.untrustedConversation, conversation());
  assert.ok(!request.args.join(" ").includes("private correction"));
  assert.ok(!request.args.join(" ").includes(options.trustedContext));
  assert.equal(request.args[request.args.indexOf("--tools") + 1], "");
  assert.equal(
    request.args[request.args.indexOf("--mcp-config") + 1],
    '{"mcpServers":{}}',
  );
  for (const flag of [
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ])
    assert.ok(request.args.includes(flag));
});

test("invalid and errored model output fails closed without echoing content", async () => {
  for (const raw of [
    "secret-content",
    success({ ...assessment, draft: "x".repeat(1801) }),
    JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      structured_output: assessment,
    }),
  ]) {
    const planner = new ClaudePlanner(options, async () => raw);
    await assert.rejects(planner.assess(conversation()), {
      message: "Claude Code did not return a valid complete assessment",
    });
  }
});

test("subscription login verification rejects missing login and API billing auth", async () => {
  for (const auth of [
    { loggedIn: false },
    { loggedIn: true, authMethod: "api_key" },
  ]) {
    await assert.rejects(
      new ClaudePlanner(options, async () => JSON.stringify(auth)).verify(),
    );
  }
  await new ClaudePlanner(options, async () =>
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
  ).verify();
});

test("child environment excludes credentials and code injection variables", () => {
  const forbidden = [
    "TELEGRAM_BOT_TOKEN",
    "GMAIL_COMPANY_REFRESH_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "NODE_OPTIONS",
    "BASH_ENV",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const previous = Object.fromEntries(
    forbidden.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of forbidden) process.env[key] = "sensitive";
    const env = cliEnvironment();
    for (const key of forbidden) assert.equal(env[key], undefined);
    assert.equal(env.HOME, process.env.HOME);
  } finally {
    for (const key of forbidden) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("CLI runner does not execute shell content and cleans its private working directory", async () => {
  const input = "$(exit 12); `exit 15`";
  const output = await runCli({
    executable: process.execPath,
    args: [
      "-e",
      'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({input:s,cwd:process.cwd()})))',
    ],
    input,
    timeoutMs: 3000,
  });
  const data = JSON.parse(output);
  assert.equal(data.input, input);
  assert.equal(existsSync(data.cwd), false);
});

test("CLI runner bounds hung and noisy providers and hides provider failures", async () => {
  await assert.rejects(
    runCli({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 100,
    }),
    /timed out/,
  );
  await assert.rejects(
    runCli({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(600000))'],
      timeoutMs: 3000,
    }),
    /output limit/,
  );
  await assert.rejects(
    runCli({
      executable: process.execPath,
      args: ["-e", 'process.stderr.write("secret-content");process.exit(1)'],
      timeoutMs: 3000,
    }),
    { message: "Model CLI failed; check login or usage limits" },
  );
  await assert.rejects(
    runCli({
      executable: "/nonexistent/assistant-provider",
      args: [],
      timeoutMs: 1000,
    }),
    /could not start/,
  );
});
