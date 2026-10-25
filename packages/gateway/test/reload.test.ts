import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  DateTime,
  Effect,
  Layer,
  Logger,
  Predicate,
  Redacted,
  Schedule,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerError,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AttachRequest, GatewayAdminApi } from "../src/admin/api.ts";
import { AnonymousCredential } from "../src/attachment/attachment.ts";
import {
  EgressProxyListenError,
  GatewayAddresses,
  GatewayReload,
  gatewayFromEnvironment,
  type Listener,
} from "../src/node/node.ts";
import { ADMIN_TOKEN_VALUE, freeGatewayPorts, REPOSITORY, WORKER } from "./fixtures.ts";

const CALLER_KEY_VALUE = "caller-key-for-reload-tests-0123456789";
const FIRST_KEY = "sk-ant-api03-firstKeyForReloadTests";
const SECOND_KEY = "sk-ant-api03-secondKeyForReloadTests";
const SUBSCRIPTION_TOKEN = "sk-ant-oat01-subscriptionTokenForReloadTests";

/** A stand-in for the Anthropic API that records each request's `x-api-key`. */
const anthropicStandIn = Effect.gen(function* () {
  const keys: Array<string> = [];
  const server = createServer((incoming, response) => {
    keys.push(incoming.headers["x-api-key"]?.toString() ?? "none");
    incoming.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"type":"message"}');
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  const address = server.address();
  assert(address !== null && !Predicate.isString(address));
  return { origin: `http://127.0.0.1:${address.port}`, keys };
});

/**
 * Writes the Gateway's files to a temporary directory in the gateway VM's cloud-init layout:
 * `settings.env`, `secrets.env`, and the allowlist that `settings.env` references.
 */
const gatewayFiles = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "usine-gateway-reload-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const path = (name: string) => join(directory, name);
  const write = (name: string, lines: ReadonlyArray<string>) =>
    Effect.promise(() => writeFile(path(name), `${lines.join("\n")}\n`));
  return { path, write };
});

type GatewayFiles = Effect.Success<typeof gatewayFiles>;

const settingsLines = (
  files: GatewayFiles,
  ports: { readonly proxy: number; readonly egress: number; readonly admin: number },
  anthropicUpstream: string,
  domain = "gw.test",
) => [
  `USINE_GATEWAY_DOMAIN=${domain}`,
  `USINE_GATEWAY_PROXY_PORT=${ports.proxy}`,
  `USINE_GATEWAY_EGRESS_PORT=${ports.egress}`,
  `USINE_GATEWAY_ADMIN_PORT=${ports.admin}`,
  `USINE_GATEWAY_EGRESS_ALLOWLIST=${files.path("egress-allowlist")}`,
  `USINE_GATEWAY_ANTHROPIC_UPSTREAM=${anthropicUpstream}`,
];

const secretsLines = (anthropicKey: string) => [
  `USINE_GATEWAY_ADMIN_TOKEN=${ADMIN_TOKEN_VALUE}`,
  `USINE_GATEWAY_CALLER_KEY=${CALLER_KEY_VALUE}`,
  `ANTHROPIC_API_KEY=${anthropicKey}`,
];

/** The Gateway's log lines with their levels, for the running test. */
const lines: Array<string> = [];
const recordLogs = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    lines.push(JSON.stringify({ level: logLevel, message }));
  }),
]);

/** Returns the first log line containing all `needles`, waiting briefly because a SIGHUP reload runs in its own fiber. */
const logged = (...needles: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const line = lines.find((candidate) => needles.every((needle) => candidate.includes(needle)));
    return line === undefined
      ? Effect.fail(new Error(`no log line contains ${needles.join(" and ")}`))
      : Effect.succeed(line);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }));

const gateway = gatewayFromEnvironment.pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);

/**
 * Writes the Gateway's files, then runs `body` against `usine-gateway` started from the files
 * in `USINE_GATEWAY_ENVIRONMENT_FILES`. If a listener can't bind, starts again on new ports.
 */
const withGateway = <A, E>(
  allowlist: ReadonlyArray<string>,
  body: (
    files: GatewayFiles,
    context: {
      readonly settings: ReadonlyArray<string>;
      readonly anthropic: ReadonlyArray<string>;
    },
  ) => Effect.Effect<A, E, GatewayAddresses | GatewayReload | HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const anthropic = yield* anthropicStandIn;
    const files = yield* gatewayFiles;
    yield* files.write("secrets.env", secretsLines(FIRST_KEY));
    yield* files.write("egress-allowlist", allowlist);
    const environment = ConfigProvider.fromEnv({
      env: {
        USINE_GATEWAY_ENVIRONMENT_FILES: `${files.path("settings.env")}:${files.path("secrets.env")}`,
      },
    });
    return yield* Effect.gen(function* () {
      lines.length = 0;
      const settings = settingsLines(files, yield* freeGatewayPorts, anthropic.origin);
      yield* files.write("settings.env", settings);
      return yield* body(files, { settings, anthropic: anthropic.keys }).pipe(
        Effect.provide(gateway),
        Effect.provideService(ConfigProvider.ConfigProvider, environment),
      );
    }).pipe(
      Effect.retry({
        while: (error) =>
          error instanceof HttpServerError.ServeError || error instanceof EgressProxyListenError,
        times: 3,
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(recordLogs));

/** The admin API client with the Gateway's admin token. */
const adminClient = Effect.gen(function* () {
  const { admin } = yield* GatewayAddresses;
  return yield* HttpApiClient.make(GatewayAdminApi, {
    baseUrl: `http://${admin.host}:${admin.port}`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE)),
  });
});

/** Returns the LLM providers the admin API reports, with each credential kind. */
const reportedProviders = Effect.gen(function* () {
  const client = yield* adminClient;
  const { providers } = yield* client.llm.providers();
  return providers.map(({ provider, credential }) => ({ provider, credential }));
});

/** Attaches the test repository to the test Worker and returns the caller token. */
const attach = Effect.gen(function* () {
  const client = yield* adminClient;
  const attached = yield* client.attachments.attach({
    payload: new AttachRequest({
      worker: WORKER,
      repository: REPOSITORY,
      credential: new AnonymousCredential(),
      expiresAt: DateTime.add(yield* DateTime.now, { minutes: 60 }),
    }),
  });
  return Redacted.value(attached.callerToken);
});

/** Sends an Anthropic request through the reverse proxy with the caller token and returns the status. */
const askAnthropic = (token: string) =>
  Effect.gen(function* () {
    const { proxy } = yield* GatewayAddresses;
    return yield* Effect.callback<number>((resume) => {
      const outgoing = request(
        {
          host: proxy.host,
          port: proxy.port,
          method: "POST",
          path: "/anthropic/v1/messages",
          headers: { host: "llm.gw.test", "x-api-key": token, "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.once("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
        },
      );
      outgoing.once("error", (error) => resume(Effect.die(error)));
      outgoing.end('{"model":"claude"}');
    });
  });

/**
 * Sends `CONNECT authority` to the forward proxy, closes the tunnel without sending anything,
 * and returns the status and refusal reason after the proxy closes its side.
 */
const connect = (proxy: Listener, authority: string) =>
  Effect.callback<{ status: number; reason: string | undefined }>((resume) => {
    const outgoing = request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
    });
    outgoing.once("connect", (response, socket) => {
      const reason = response.headers["x-usine-gateway-refusal"]?.toString();
      socket.on("error", () => socket.destroy());
      socket.once("close", () =>
        resume(Effect.succeed({ status: response.statusCode ?? 0, reason })),
      );
      socket.end();
    });
    outgoing.once("error", (error) => resume(Effect.die(error)));
    outgoing.end();
  });

const admitted = { status: 200, reason: undefined };
const refused = { status: 403, reason: "host-not-allowed" };

describe("reloading the gateway", () => {
  it.live(
    "a new allowlist admits a host the old one refused and refuses one it admitted, and the attachment still works",
    () =>
      withGateway(["registry.npmjs.org"], (files) =>
        Effect.gen(function* () {
          const { egress } = yield* GatewayAddresses;
          const token = yield* attach;
          assert.deepStrictEqual(yield* connect(egress, "registry.npmjs.org:443"), admitted);
          assert.deepStrictEqual(yield* connect(egress, "pypi.org:443"), refused);

          yield* files.write("egress-allowlist", ["pypi.org", "files.pythonhosted.org"]);
          yield* (yield* GatewayReload).reload;

          assert.deepStrictEqual(yield* connect(egress, "pypi.org:443"), admitted);
          assert.deepStrictEqual(yield* connect(egress, "registry.npmjs.org:443"), refused);
          assert.strictEqual(yield* askAnthropic(token), 200);
          const reloaded = yield* logged("Reloaded the gateway settings");
          assert.include(reloaded, '"level":"Info"');
          assert.include(reloaded, `"path":"${files.path("egress-allowlist")}"`);
          assert.include(reloaded, '"rules":2');
          assert.include(reloaded, '"changed":[]');
        }),
      ),
  );

  it.live("a broken allowlist keeps the previous one and the attachment", () =>
    withGateway(["registry.npmjs.org"], (files) =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        const token = yield* attach;

        yield* files.write("egress-allowlist", ["pypi.org", "https://files.pythonhosted.org/"]);
        yield* (yield* GatewayReload).reload;

        assert.deepStrictEqual(yield* connect(egress, "registry.npmjs.org:443"), admitted);
        assert.deepStrictEqual(yield* connect(egress, "pypi.org:443"), refused);
        assert.strictEqual(yield* askAnthropic(token), 200);
        const kept = yield* logged("Kept the previous egress allowlist");
        assert.include(kept, '"level":"Error"');
        assert.include(kept, `"path":"${files.path("egress-allowlist")}"`);
        assert.include(kept, '"line":2');
        assert.include(kept, "https://files.pythonhosted.org/");
        assert.include(yield* logged("Reloaded the gateway settings"), '"allowlist":"kept"');
      }),
    ),
  );

  it.live("a new API key is sent on the next request, and the log names it without its value", () =>
    withGateway(["registry.npmjs.org"], (files, { anthropic }) =>
      Effect.gen(function* () {
        const token = yield* attach;
        assert.strictEqual(yield* askAnthropic(token), 200);

        yield* files.write("secrets.env", secretsLines(SECOND_KEY));
        yield* (yield* GatewayReload).reload;

        assert.strictEqual(yield* askAnthropic(token), 200);
        assert.deepStrictEqual(anthropic, [FIRST_KEY, SECOND_KEY]);
        assert.include(
          yield* logged("Reloaded the gateway settings"),
          '"changed":["ANTHROPIC_API_KEY"]',
        );
        assert.notInclude(lines.join("\n"), FIRST_KEY);
        assert.notInclude(lines.join("\n"), SECOND_KEY);
      }),
    ),
  );

  it.live(
    "the admin API reports the kind of Anthropic credential in force: an API key, then the subscription token a reload swapped in",
    () =>
      withGateway(["registry.npmjs.org"], (files) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* reportedProviders, [
            { provider: "anthropic", credential: "api-key" },
          ]);

          yield* files.write("secrets.env", [
            ...secretsLines(FIRST_KEY).filter((line) => !line.startsWith("ANTHROPIC_API_KEY=")),
            `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN=${SUBSCRIPTION_TOKEN}`,
          ]);
          yield* (yield* GatewayReload).reload;

          assert.deepStrictEqual(yield* reportedProviders, [
            { provider: "anthropic", credential: "subscription" },
          ]);
          assert.notInclude(lines.join("\n"), SUBSCRIPTION_TOKEN);
        }),
      ),
  );

  it.live("settings that need a restart are logged and left as they are", () =>
    withGateway(["registry.npmjs.org"], (files, { settings }) =>
      Effect.gen(function* () {
        const token = yield* attach;
        yield* files.write("settings.env", [
          ...settings.filter(
            (line) =>
              !line.startsWith("USINE_GATEWAY_DOMAIN=") &&
              !line.startsWith("USINE_GATEWAY_ADMIN_PORT="),
          ),
          "USINE_GATEWAY_DOMAIN=gw.elsewhere",
          "USINE_GATEWAY_ADMIN_PORT=7071",
        ]);
        yield* (yield* GatewayReload).reload;

        assert.strictEqual(yield* askAnthropic(token), 200);
        const restart = yield* logged("take effect only after a restart");
        assert.include(restart, '"level":"Warn"');
        assert.include(restart, '"USINE_GATEWAY_DOMAIN"');
        assert.include(restart, '"USINE_GATEWAY_ADMIN_PORT"');
      }),
    ),
  );

  it.live("SIGHUP runs the reload", () =>
    withGateway(["registry.npmjs.org"], (files) =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        yield* files.write("egress-allowlist", ["pypi.org"]);
        process.emit("SIGHUP", "SIGHUP");
        yield* logged("Reloaded the gateway settings");
        assert.deepStrictEqual(yield* connect(egress, "pypi.org:443"), admitted);
        assert.deepStrictEqual(yield* connect(egress, "registry.npmjs.org:443"), refused);
      }),
    ),
  );
});
