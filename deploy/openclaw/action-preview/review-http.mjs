export async function reviewHttp({ req, path, reply }, input, service) {
  if (path === "/api/reviews" && req.method === "GET") {
    reply(200, await service.list());
    return true;
  }
  if (path === "/api/reviews/decision" && req.method === "POST") {
    reply(200, await service.resolve(await input()));
    return true;
  }
  if (await extraRoute({ req, path, reply }, input, service)) return true;
  const match = path.match(
    /^\/api\/reviews\/([a-f0-9-]{36})\/(open|reject|edit|answer)$/,
  );
  if (!match || req.method !== "POST") return false;
  const p = await input();
  const [, id, operation] = match;
  const value = operation === "answer" ? p.answer : p.action;
  reply(200, await service[operation](id, p.version, value));
  return true;
}

async function extraRoute({ req, path, reply }, input, service) {
  if (req.method !== "POST") return false;
  if (path === "/api/reviews/request") {
    const p = await input();
    reply(202, await service.request(p.text, p.key));
    return true;
  }
  if (path === "/api/reviews/revise") {
    reply(200, await service.revise(await input()));
    return true;
  }
  return false;
}
