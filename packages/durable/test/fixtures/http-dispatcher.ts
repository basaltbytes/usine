import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, Schema } from "effect";
import { EnvHttpProxyAgent, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { DurableHarness } from "../../src/harness.ts";
import { harnessLayer } from "../../src/live.ts";

assert(process.argv[2]);
const directory = InstanceDirectory.make(process.argv[2]);
const scenario = process.argv[3];
const initialDispatcher = getGlobalDispatcher();
const initialFetch = globalThis.fetch;
const customFetch: typeof fetch = (...args) => initialFetch(...args);
if (scenario === "custom") globalThis.fetch = customFetch;

const origin = createServer((request, response) => {
  if (request.url === "/broken") {
    response.writeHead(200, { "content-length": "1000" });
    response.write("partial");
    setTimeout(() => response.destroy(), 20);
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
  response.end(gzipSync(JSON.stringify({ ok: true })));
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const originAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
  origin.address(),
);

const tunnels: Array<string | undefined> = [];
const proxy = createServer();
proxy.on("connect", (request, socket, head) => {
  tunnels.push(request.url);
  const upstream = connect(originAddress.port, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
  proxy.address(),
);
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
if (scenario === "environment") {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
}
await mkdir(join(directory, "pi"));
await writeFile(
  join(directory, "pi/settings.json"),
  JSON.stringify({
    httpProxy: scenario === "environment" ? "invalid-proxy" : `  ${proxyUrl}  `,
  }),
);
// Project settings must not control the orchestrator's process-wide proxy.
await mkdir(join(directory, ".pi"));
await writeFile(
  join(directory, ".pi/settings.json"),
  JSON.stringify({ httpProxy: "invalid-project-proxy" }),
);

const openHarness = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const harness = yield* DurableHarness;
      yield* harness.use("check the HTTP dispatcher", async () => {
        assert(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
      });
    }).pipe(Effect.provide(harnessLayer(directory)), Effect.scoped),
  );

try {
  assert.strictEqual(getGlobalDispatcher(), initialDispatcher);
  await openHarness();
  const dispatcher = getGlobalDispatcher();
  assert.notStrictEqual(dispatcher, initialDispatcher);
  assert.strictEqual(process.env.HTTP_PROXY, proxyUrl);
  assert.strictEqual(process.env.HTTPS_PROXY, proxyUrl);
  if (scenario === "custom") assert.strictEqual(globalThis.fetch, customFetch);
  else {
    assert.notStrictEqual(globalThis.fetch, initialFetch);
    assert.strictEqual(globalThis.fetch, undiciFetch);
  }
  await openHarness();
  assert.strictEqual(getGlobalDispatcher(), dispatcher);

  const direct = await fetch(`http://127.0.0.1:${originAddress.port}/json`);
  assert.deepStrictEqual(await direct.json(), { ok: true });
  assert.strictEqual(tunnels.length, 0);
  const proxied = await fetch(`http://pi.invalid:${originAddress.port}/json`);
  assert.deepStrictEqual(await proxied.json(), { ok: true });
  assert.deepStrictEqual(tunnels, [`pi.invalid:${originAddress.port}`]);
  await assert.rejects(
    fetch(`http://127.0.0.1:${originAddress.port}/broken`).then((response) => response.text()),
  );
  const recovered = await fetch(`http://127.0.0.1:${originAddress.port}/json`);
  assert.deepStrictEqual(await recovered.json(), { ok: true });
} finally {
  await getGlobalDispatcher().destroy();
  await Promise.all([
    new Promise<void>((resolve) => origin.close(() => resolve())),
    new Promise<void>((resolve) => proxy.close(() => resolve())),
  ]);
}
