import { jsonKey } from "@usine/core/json-key";
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { strict as assert } from "node:assert";
import { once } from "node:events";
// The standalone SDK fixture writes its bootstrap files synchronously before opening the harness.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { connect } from "node:net";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, Option, Schema } from "effect";
import { ModelId } from "@usine/core/agent/brain";
import { resolveParent } from "../../src/parent.ts";
import { EnvHttpProxyAgent, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { gatewayModelAccess } from "../../src/gateway.ts";
import { DurableHarness } from "../../src/harness.ts";
import { loadParentModels, harnessLayer } from "../../src/live.ts";

assert(process.argv[2]);
const directory = InstanceDirectory.make(process.argv[2]);
const scenario = process.argv[3];
const initialDispatcher = getGlobalDispatcher();
const initialFetch = globalThis.fetch;
// This fixture intercepts the fetch function installed by the vendor SDK.
// @effect-diagnostics-next-line globalFetch:off
const customFetch: typeof globalThis.fetch = (...args) => initialFetch(...args);
if (scenario === "custom") globalThis.fetch = customFetch;

const origin = createServer((request, response) => {
  if (request.url === "/broken") {
    response.writeHead(200, { "content-length": "1000" });
    response.write("partial");
    // The native fault-injection callback destroys a partially written response after one tick.
    // @effect-diagnostics-next-line globalTimers:off
    setTimeout(() => response.destroy(), 20);
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
  response.end(gzipSync(jsonKey({ ok: true })));
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
// The proxy callback reads the listening port synchronously.
// @effect-diagnostics-next-line schemaSync:off
const originAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
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
// The standalone fixture configures the proxy before starting its harness.
// @effect-diagnostics-next-line schemaSync:off
const proxyAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
  proxy.address(),
);
const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
if (scenario === "environment") {
  // This fixture verifies the SDK bridge’s process-wide environment mutation.
  // @effect-diagnostics-next-line processEnv:off
  process.env.HTTP_PROXY = proxyUrl;
  // This fixture verifies the SDK bridge’s process-wide environment mutation.
  // @effect-diagnostics-next-line processEnv:off
  process.env.HTTPS_PROXY = proxyUrl;
}
mkdirSync(join(directory, "pi"));
writeFileSync(
  join(directory, "pi/settings.json"),
  jsonKey({
    httpProxy: scenario === "environment" ? "invalid-proxy" : `  ${proxyUrl}  `,
  }),
);
// Project settings must not control the orchestrator's process-wide proxy.
mkdirSync(join(directory, ".pi"));
writeFileSync(
  join(directory, ".pi/settings.json"),
  jsonKey({ httpProxy: "invalid-project-proxy" }),
);

const access =
  scenario === "gateway"
    ? gatewayModelAccess({
        credential: async () => "subscription",
        request: async () => {
          throw new Error("model requests are not used by this fixture");
        },
      })
    : undefined;

const openHarness = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const harness = yield* DurableHarness;
      if (access !== undefined) {
        assert.strictEqual(harness.models, access.models);
        const resolved = yield* resolveParent(
          harness.models,
          harness.defaultModel,
          {
            parentModel: Option.some(ModelId.make("openai-codex/gpt-5.6-sol")),
            parentEffort: "high",
          },
          Option.none(),
          harness.parentAuthentication,
        );
        assert.strictEqual(resolved.pool, "chatgptPlan");
      }
      yield* harness.use("check the HTTP dispatcher", async () => {
        assert(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
      });
    }).pipe(Effect.provide(harnessLayer(directory, access)), Effect.scoped),
  );

try {
  assert.strictEqual(getGlobalDispatcher(), initialDispatcher);
  if (scenario === "unknown-parent") {
    await assert.rejects(
      Effect.runPromise(
        Effect.gen(function* () {
          const parents = yield* loadParentModels(directory);
          yield* resolveParent(parents.models, parents.defaultModel, {
            parentModel: Option.some(ModelId.make("missing/parent-model")),
            parentEffort: "high",
          });
        }),
      ),
      /Pi has no model "missing\/parent-model"/u,
    );
    assert.strictEqual(existsSync(join(directory, ".usine/durable.sqlite")), false);
  }
  await openHarness();
  const dispatcher = getGlobalDispatcher();
  assert.notStrictEqual(dispatcher, initialDispatcher);
  // This fixture verifies the SDK bridge’s process-wide environment mutation.
  // @effect-diagnostics-next-line processEnv:off
  assert.strictEqual(process.env.HTTP_PROXY, proxyUrl);
  // This fixture verifies the SDK bridge’s process-wide environment mutation.
  // @effect-diagnostics-next-line processEnv:off
  assert.strictEqual(process.env.HTTPS_PROXY, proxyUrl);
  if (scenario === "custom") assert.strictEqual(globalThis.fetch, customFetch);
  else {
    assert.notStrictEqual(globalThis.fetch, initialFetch);
    assert.strictEqual(globalThis.fetch, undiciFetch);
  }
  await openHarness();
  assert.strictEqual(getGlobalDispatcher(), dispatcher);

  // This fixture exercises the SDK-installed global fetch override directly.
  // @effect-diagnostics-next-line globalFetch:off
  const direct = await fetch(`http://127.0.0.1:${originAddress.port}/json`);
  assert.deepStrictEqual(await direct.json(), { ok: true });
  assert.strictEqual(tunnels.length, 0);
  // This fixture exercises the SDK-installed global fetch override directly.
  // @effect-diagnostics-next-line globalFetch:off
  const proxied = await fetch(`http://pi.invalid:${originAddress.port}/json`);
  assert.deepStrictEqual(await proxied.json(), { ok: true });
  assert.deepStrictEqual(tunnels, [`pi.invalid:${originAddress.port}`]);
  await assert.rejects(
    // This fixture exercises the SDK-installed global fetch override directly.
    // @effect-diagnostics-next-line globalFetch:off
    fetch(`http://127.0.0.1:${originAddress.port}/broken`).then((response) => response.text()),
  );
  // This fixture exercises the SDK-installed global fetch override directly.
  // @effect-diagnostics-next-line globalFetch:off
  const recovered = await fetch(`http://127.0.0.1:${originAddress.port}/json`);
  assert.deepStrictEqual(await recovered.json(), { ok: true });
} finally {
  await getGlobalDispatcher().destroy();
  await Effect.runPromise(
    Effect.all(
      [
        Effect.callback<void>((resume) => {
          origin.close(() => resume(Effect.void));
        }),
        Effect.callback<void>((resume) => {
          proxy.close(() => resume(Effect.void));
        }),
      ],
      { concurrency: "unbounded" },
    ),
  );
}
