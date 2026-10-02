import { reviewHttp } from "./review-http.mjs";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

function equal(a, b) {
  return (
    typeof a === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function accessToken(path) {
  let token;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    token = randomBytes(32).toString("hex");
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid inbox access token.");
  chmodSync(path, 0o600);
  return token;
}
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 64000) throw Error("Request too large.");
  }
  return JSON.parse(data || "{}");
}

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);
function serveAsset({ req, res, path }) {
  if (req.method !== "GET" || !assets.has(path)) return false;
  const [file, type] = assets.get(path);
  res.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
  res.end(readFileSync(new URL("./inbox-web/" + file, import.meta.url)));
  return true;
}
function checkRequest(req, port) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    throw Error("Local host required.");
  const origin = `http://${host}`;
  if (req.headers.origin && req.headers.origin !== origin)
    throw Error("Origin rejected.");
  if (!["GET", "POST", "PATCH"].includes(req.method))
    throw Error("Method not allowed.");
  if (
    req.method !== "GET" &&
    (req.headers.origin !== origin ||
      req.headers["content-type"] !== "application/json")
  )
    throw Error("Same-origin JSON required.");
  return new URL(req.url, origin).pathname;
}
function authenticate(req, sessions) {
  const cookie = req.headers.cookie ?? "";
  const session = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("secretary_inbox="))
    ?.slice(16);
  return Boolean(session && (sessions.get(session) ?? 0) >= Date.now());
}
async function signIn(c) {
  if (!equal((await body(c.req)).token, c.token))
    return c.reply(401, {
      error: "Open the inbox from the Mac launcher to sign in.",
    });
  for (const [key, expiry] of c.sessions)
    if (expiry < Date.now()) c.sessions.delete(key);
  if (c.sessions.size > 64) c.sessions.delete(c.sessions.keys().next().value);
  const session = randomBytes(32).toString("hex");
  c.sessions.set(session, Date.now() + 86400000);
  c.res.setHeader(
    "Set-Cookie",
    `secretary_inbox=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
  );
  c.reply(200, { ok: true });
}
async function routeTasks(c) {
  const { req, path, reply, store } = c;
  if (path === "/api/tasks" && req.method === "GET") {
    store.recover();
    return reply(200, { tasks: store.list() });
  }
  if (path === "/api/notes" && req.method === "GET")
    return reply(200, { text: c.notes() });
  if (path === "/api/tasks" && req.method === "POST") {
    const input = await body(req);
    return reply(201, { tasks: store.capture(input.text, "web", input.key) });
  }
  if (/^\/api\/tasks\/[a-f0-9-]{36}$/.test(path) && req.method === "PATCH")
    return patchTask(c);
  reply(404, { error: "Not found." });
}
async function patchTask(c) {
  const input = await body(c.req);
  const task = c.store.update(
    c.path.split("/").at(-1),
    input.version,
    input.patch,
  );
  if (task.status === "queued") {
    try {
      c.wake();
    } catch {
      /* Next heartbeat picks up durable work. */
    }
  }
  c.reply(200, { task });
}
function responseHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}
export function createInboxServer({
  store,
  token,
  wake = () => {},
  notes = () => "",
  getReview,
}) {
  const sessions = new Map();
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    responseHeaders(res);
    let path;
    try {
      path = checkRequest(req, server.address()?.port);
    } catch (e) {
      return reply(403, { error: e.message });
    }
    const context = {
      req,
      res,
      path,
      reply,
      store,
      token,
      wake,
      notes,
      sessions,
    };
    try {
      if (serveAsset(context)) return;
      if (path === "/api/session" && req.method === "POST")
        return await signIn(context);
      if (!authenticate(req, sessions))
        return reply(401, {
          error: "Open the inbox from the Mac launcher to sign in.",
        });
      if (await routeReview(context, getReview)) return;
      return await routeTasks(context);
    } catch (e) {
      reply(400, { error: e instanceof Error ? e.message : "Request failed." });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function routeReview(context, getReview) {
  if (!getReview || !context.path.startsWith("/api/reviews")) return false;
  return reviewHttp(context, () => body(context.req), getReview());
}
