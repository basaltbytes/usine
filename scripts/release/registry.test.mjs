import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { unpublishedPackages } from "./registry.mjs";

test("release approval checks the public version endpoint", async (t) => {
  const first = { name: "@usine/first", version: "1.0.0" };
  const second = { name: "@usine/second", version: "2.0.0" };
  const replies = new Map();
  const server = createServer((request, response) => {
    const reply = replies.get(decodeURIComponent(request.url));
    response.writeHead(reply?.status ?? 404, { "content-type": "application/json" });
    response.end(reply?.body ?? JSON.stringify({ error: "Not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = `http://127.0.0.1:${server.address().port}/`;

  const reply = (pkg, status, body = pkg) =>
    replies.set(`/${pkg.name}/${pkg.version}`, { status, body: JSON.stringify(body) });

  await t.test("keeps every unavailable version pending, including partial approvals", async () => {
    assert.deepEqual(await unpublishedPackages([first, second], registry), [
      "@usine/first@1.0.0",
      "@usine/second@2.0.0",
    ]);
    reply(first, 200);
    assert.deepEqual(await unpublishedPackages([first, second], registry), ["@usine/second@2.0.0"]);
    reply(second, 200);
    assert.deepEqual(await unpublishedPackages([first, second], registry), []);
  });

  await t.test("fails closed on registry errors instead of treating them as approval", async () => {
    reply(second, 503);
    await assert.rejects(unpublishedPackages([first, second], registry), /HTTP 503/);
    reply(second, 401);
    await assert.rejects(unpublishedPackages([first, second], registry), /HTTP 401/);
  });

  await t.test("requires the exact package and version in public metadata", async () => {
    reply(second, 200, { ...second, version: "1.0.0" });
    await assert.rejects(unpublishedPackages([second], registry), /unexpected metadata/);
    reply(second, 200, { ...second, name: "@usine/other" });
    await assert.rejects(unpublishedPackages([second], registry), /unexpected metadata/);
  });

  await t.test("fails closed on malformed registry responses", async () => {
    replies.set(`/${second.name}/${second.version}`, { status: 200, body: "not json" });
    await assert.rejects(unpublishedPackages([second], registry), SyntaxError);
  });
});
