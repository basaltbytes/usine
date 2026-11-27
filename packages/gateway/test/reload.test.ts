import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
} from "@usine/core/agent/provider";
import { jsonKey } from "@usine/core/json-key";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { NodeCrypto, NodeServices, NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  DateTime,
  Effect,
  Layer,
  Logger,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  FileSystem,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AttachRequest, GatewayAdminApi, LlmProviderList } from "../src/admin/api.ts";
import { AnonymousCredential } from "../src/attachment/attachment.ts";
import { ApiKey, LlmProvider } from "../src/llm/llm.ts";
import {
  EgressProxyListenError,
  GatewayAddresses,
  GatewayReload,
  gatewayFromEnvironment,
  type Listener,
} from "../src/node/node.ts";
import { readSettingsSource, readStartupSettings } from "../src/node/environment.ts";
import {
  ADMIN_TOKEN_VALUE,
  authFileText,
  chatGptAccessToken,
  freeGatewayPorts,
  REPOSITORY,
  WORKER,
} from "./fixtures.ts";

const CALLER_KEY_VALUE = "caller-key-for-reload-tests-0123456789";
const FIRST_KEY = "sk-ant-api03-firstKeyForReloadTests";
const SECOND_KEY = "sk-ant-api03-secondKeyForReloadTests";
const SUBSCRIPTION_TOKEN = "sk-ant-oat01-subscriptionTokenForReloadTests";
const OPENAI_KEY = "sk-proj-keyForReloadTests0123456789";
const CHATGPT_REFRESH = "rt-chatgptRefreshTokenForReloadTests";

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
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname(join(tmpdir(), "usine-gateway-reload-")),
        prefix: basename(join(tmpdir(), "usine-gateway-reload-")),
      }),
    ),
    (path) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(path, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  );
  const path = (name: string) => join(directory, name);
  const write = (name: string, lines: ReadonlyArray<string>) =>
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.writeFileString(path(name), `${lines.join("\n")}\n`),
    );
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
  `STATE_DIRECTORY=${files.path("state")}`,
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

/** The log message of a reload that keeps the providers in force. */
const KEPT_PROVIDERS = "Kept the previous LLM providers";
const recordLogs = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    lines.push(jsonKey({ level: logLevel, message }));
  }),
]);

/** Returns the first log line containing all `needles`, waiting briefly because a SIGHUP reload runs in its own fiber. */
const logged = (...needles: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const line = lines.find((candidate) => needles.every((needle) => candidate.includes(needle)));
    return line === undefined
      ? Effect.fail(
          LogLineMissing.make({ message: `no log line contains ${needles.join(" and ")}` }),
        )
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
    context: { readonly anthropic: ReadonlyArray<string> },
  ) => Effect.Effect<
    A,
    E,
    GatewayAddresses | GatewayReload | HttpClient.HttpClient | FileSystem.FileSystem
  >,
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
      const gatewayPorts = yield* freeGatewayPorts;
      yield* files.write("settings.env", settingsLines(files, gatewayPorts, anthropic.origin));
      return yield* body(files, { anthropic: anthropic.keys }).pipe(
        Effect.provide(gateway),
        Effect.provideService(ConfigProvider.ConfigProvider, environment),
      );
    }).pipe(
      Effect.retry({
        while: (error) =>
          error instanceof HttpServerError.ServeError || Schema.is(EgressProxyListenError)(error),
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
/** The provider report as orchestrators from before the provider catalog decode it. */
const ReportBeforeCatalog = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.Literals(["anthropic", "openai", "anthropic-messages", "openai-responses"]),
      credential: Schema.Literals(["api-key", "subscription"]),
    }),
  ),
});

const reportedProviders = Effect.gen(function* () {
  const client = yield* adminClient;
  const { providers } = yield* client.llm.providers();
  return providers.map(({ provider, credential }) => ({ provider, credential }));
});

/** Attaches the test repository to the test Worker and returns the caller token. */
const attach = Effect.gen(function* () {
  const client = yield* adminClient;
  const currentNow = yield* DateTime.now;
  const attached = yield* client.attachments.attach({
    payload: AttachRequest.make({
      worker: WORKER,
      repository: REPOSITORY,
      credential: AnonymousCredential.make(),
      expiresAt: DateTime.add(currentNow, { minutes: 60 }),
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
          path: "/anthropic-messages/v1/messages",
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
  it.live("a broken allowlist keeps the previous one and the attachment", () =>
    withGateway(["registry.npmjs.org"], (files) =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        const token = yield* attach;

        yield* files.write("egress-allowlist", ["pypi.org", "https://files.pythonhosted.org/"]);
        yield* (yield* GatewayReload).reload;

        const connectionResponse = yield* connect(egress, "registry.npmjs.org:443");
        assert.deepStrictEqual(connectionResponse, admitted);
        const currentConnectionResponse = yield* connect(egress, "pypi.org:443");
        assert.deepStrictEqual(currentConnectionResponse, refused);
        const providerResponse = yield* askAnthropic(token);
        assert.strictEqual(providerResponse, 200);
        const kept = yield* logged("Kept the previous egress allowlist");
        assert.include(kept, '"level":"Error"');
        assert.include(kept, `"path":"${files.path("egress-allowlist")}"`);
        assert.include(kept, '"line":2');
        assert.include(kept, "https://files.pythonhosted.org/");
        const loggedMessages = yield* logged("Reloaded the gateway settings");
        assert.include(loggedMessages, '"allowlist":"kept"');
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("a new API key is sent on the next request, and the log names it without its value", () =>
    withGateway(["registry.npmjs.org"], (files, { anthropic }) =>
      Effect.gen(function* () {
        const token = yield* attach;
        const providerResponse = yield* askAnthropic(token);
        assert.strictEqual(providerResponse, 200);

        yield* files.write("secrets.env", secretsLines(SECOND_KEY));
        yield* (yield* GatewayReload).reload;

        const currentProviderResponse = yield* askAnthropic(token);
        assert.strictEqual(currentProviderResponse, 200);
        assert.deepStrictEqual(anthropic, [FIRST_KEY, SECOND_KEY]);
        const loggedMessages = yield* logged("Reloaded the gateway settings");
        assert.include(loggedMessages, '"changed":["ANTHROPIC_API_KEY"]');
        assert.notInclude(lines.join("\n"), FIRST_KEY);
        assert.notInclude(lines.join("\n"), SECOND_KEY);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "the admin API reports the kind of Anthropic credential in force: an API key, then the subscription token a reload swapped in",
    () =>
      withGateway(["registry.npmjs.org"], (files) =>
        Effect.gen(function* () {
          const providers = yield* reportedProviders;
          assert.deepStrictEqual(providers, [
            { provider: "anthropic-messages", credential: "api-key" },
          ]);

          yield* files.write("secrets.env", [
            ...secretsLines(FIRST_KEY).filter((line) => !line.startsWith("ANTHROPIC_API_KEY=")),
            `USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN=${SUBSCRIPTION_TOKEN}`,
          ]);
          yield* (yield* GatewayReload).reload;

          const currentProviders = yield* reportedProviders;
          assert.deepStrictEqual(currentProviders, [
            { provider: "anthropic-messages", credential: "subscription" },
          ]);
          assert.notInclude(lines.join("\n"), SUBSCRIPTION_TOKEN);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "the provider report lists every slot with its routes and credential, in a shape that orchestrators from before the catalog read",
    () =>
      withGateway(["registry.npmjs.org"], () =>
        Effect.gen(function* () {
          const client = yield* adminClient;
          const report = yield* client.llm.providers();
          assert.deepStrictEqual(
            report.slots?.map(({ slot, routes }) => [slot, routes]),
            modelProviders.providers.map(({ slot, routes }) => [slot, routes]),
          );
          const encoded = yield* Schema.encodeEffect(LlmProviderList)(report);
          assert.deepStrictEqual(
            Schema.decodeUnknownOption(ReportBeforeCatalog)(encoded),
            Option.some({ providers: [{ provider: "anthropic-messages", credential: "api-key" }] }),
          );

          const plan = ModelProvider.make({
            ...anthropic,
            id: ModelProviderId.make("test-plan"),
            slot: GatewaySlot.make("test-plan"),
            credentials: [
              ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") }),
            ],
            upstreamVariable: Option.none(),
          });
          const keyed = LlmProvider.make({
            upstream: Option.none(),
            credential: ApiKey.make({ key: Redacted.make(FIRST_KEY) }),
          });
          const withPlan = LlmProviderList.fromProviders(
            ModelProviderCatalog.make({ providers: [...modelProviders.providers, plan] }),
            { [anthropic.slot]: keyed, [plan.slot]: keyed },
          );
          assert.deepStrictEqual(
            withPlan.slots?.map(({ slot, credential }) => [slot, credential]),
            [
              ["anthropic-messages", "api-key"],
              ["openai-responses", undefined],
              ["opencode-go", undefined],
              ["test-plan", "api-key"],
            ],
          );
          const encodedWithPlan = yield* Schema.encodeEffect(LlmProviderList)(withPlan);
          assert.deepStrictEqual(
            Schema.decodeUnknownOption(ReportBeforeCatalog)(encodedWithPlan),
            Option.some({ providers: [{ provider: "anthropic-messages", credential: "api-key" }] }),
          );
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "a ChatGPT login replaces the OpenAI key, and a conflicting or unusable one keeps the providers in force",
    () =>
      withGateway(["registry.npmjs.org"], (files) =>
        Effect.gen(function* () {
          const reload = Effect.flatMap(GatewayReload, ({ reload }) => reload);
          const authFile = `USINE_GATEWAY_CHATGPT_AUTH_FILE=${files.path("auth.json")}`;
          const currentNow = yield* DateTime.now;
          const access = chatGptAccessToken(DateTime.add(currentNow, { hours: 1 }));
          yield* files.write("secrets.env", [
            ...secretsLines(FIRST_KEY),
            `OPENAI_API_KEY=${OPENAI_KEY}`,
          ]);
          yield* reload;
          const withKey = [
            { provider: "anthropic-messages", credential: "api-key" },
            { provider: "openai-responses", credential: "api-key" },
          ];
          const providers = yield* reportedProviders;
          assert.deepStrictEqual(providers, withKey);

          yield* files.write("auth.json", [authFileText({ access, refresh: CHATGPT_REFRESH })]);
          yield* files.write("secrets.env", [
            ...secretsLines(FIRST_KEY),
            `OPENAI_API_KEY=${OPENAI_KEY}`,
            authFile,
          ]);
          yield* reload;
          yield* logged(
            "Kept the previous LLM providers",
            "OPENAI_API_KEY and USINE_GATEWAY_CHATGPT_AUTH_FILE are both set",
          );
          const currentProviders = yield* reportedProviders;
          assert.deepStrictEqual(currentProviders, withKey);

          yield* files.write("auth.json", ['{"OPENAI_API_KEY":null}']);
          yield* files.write("secrets.env", [...secretsLines(FIRST_KEY), authFile]);
          yield* reload;
          yield* logged("Kept the previous LLM providers", "isn't a Codex ChatGPT login");
          const nextProviders = yield* reportedProviders;
          assert.deepStrictEqual(nextProviders, withKey);

          yield* files.write("auth.json", [authFileText({ access, refresh: CHATGPT_REFRESH })]);
          yield* reload;
          const updatedProviders = yield* reportedProviders;
          assert.deepStrictEqual(updatedProviders, [
            { provider: "anthropic-messages", credential: "api-key" },
            { provider: "openai-responses", credential: "subscription" },
          ]);
          yield* logged("Loaded the ChatGPT login", files.path("auth.json"));
          assert.include(
            lines.filter((line) => line.includes("Reloaded the gateway settings")).at(-1),
            '"changed":["OPENAI_API_KEY","USINE_GATEWAY_CHATGPT_AUTH_FILE"]',
          );
          for (const secret of [OPENAI_KEY, CHATGPT_REFRESH, access])
            assert.notInclude(lines.join("\n"), secret);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "an upstream override over plain HTTP to another host keeps the providers in force on a reload, and fails a startup, naming the variable",
    () =>
      withGateway(["registry.npmjs.org"], (files, { anthropic }) =>
        Effect.gen(function* () {
          const token = yield* attach;
          const { proxy, egress, admin } = yield* GatewayAddresses;
          const ports = { proxy: proxy.port, egress: egress.port, admin: admin.port };
          // The second value parses with the upstream pattern, but not as a URL.
          for (const upstream of ["http://anthropic-override.test", "http://localhost:99999"]) {
            yield* files.write("settings.env", [
              ...settingsLines(files, ports, "https://api.anthropic.com"),
              `USINE_GATEWAY_ANTHROPIC_UPSTREAM=${upstream}`,
            ]);
            const keptBefore = lines.filter((line) => line.includes(KEPT_PROVIDERS)).length;
            yield* (yield* GatewayReload).reload;

            const kept = lines.filter((line) => line.includes(KEPT_PROVIDERS));
            assert.strictEqual(kept.length, keptBefore + 1);
            assert.include(kept.at(-1), "USINE_GATEWAY_ANTHROPIC_UPSTREAM");
            assert.include(kept.at(-1), "http:// to a loopback host");
          }
          const providerResponse = yield* askAnthropic(token);
          assert.strictEqual(providerResponse, 200);
          assert.deepStrictEqual(anthropic, [FIRST_KEY]);
          const environment = yield* ConfigProvider.ConfigProvider;
          const source = yield* readSettingsSource(environment);
          const startup = yield* readStartupSettings(source).pipe(
            Effect.as("started"),
            Effect.catchTag("ConfigError", ({ message }) => Effect.succeed(message)),
            Effect.provide(NodeCrypto.layer),
          );
          assert.include(startup, "USINE_GATEWAY_ANTHROPIC_UPSTREAM");
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "SIGHUP reloads the allowlist: it admits a host the old one refused and refuses one it admitted",
    () =>
      withGateway(["registry.npmjs.org"], (files) =>
        Effect.gen(function* () {
          const { egress } = yield* GatewayAddresses;
          const connectionResponse = yield* connect(egress, "registry.npmjs.org:443");
          assert.deepStrictEqual(connectionResponse, admitted);
          const currentConnectionResponse = yield* connect(egress, "pypi.org:443");
          assert.deepStrictEqual(currentConnectionResponse, refused);

          yield* files.write("egress-allowlist", ["pypi.org", "files.pythonhosted.org"]);
          process.emit("SIGHUP", "SIGHUP");

          const reloaded = yield* logged("Reloaded the gateway settings");
          assert.include(reloaded, '"level":"Info"');
          assert.include(reloaded, `"path":"${files.path("egress-allowlist")}"`);
          assert.include(reloaded, '"rules":2');
          assert.include(reloaded, '"changed":[]');
          const nextConnectionResponse = yield* connect(egress, "pypi.org:443");
          assert.deepStrictEqual(nextConnectionResponse, admitted);
          const updatedConnectionResponse = yield* connect(egress, "registry.npmjs.org:443");
          assert.deepStrictEqual(updatedConnectionResponse, refused);
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

class LogLineMissing extends Schema.TaggedError<
  LogLineMissing,
  { readonly Brand: unique symbol }
>()("LogLineMissing", {
  message: Schema.String,
}) {}
