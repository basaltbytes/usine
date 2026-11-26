import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  openai,
  ProviderProtocol,
  RoutePattern,
  UpstreamBase,
  WireProtocol,
} from "@usine/core/agent/provider";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { preflight } from "@usine/agents/preflight";
import { harnessesLive, ProbeTarget } from "@usine/agents/harness/node";
import { HostLoginLock } from "@usine/agents/runtime";
import { WorkerName } from "@usine/core/worker";
import { LocalProcess } from "@usine/agents/child-host";
import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient } from "effect/http";
import {
  SettingsInForce,
  GatewaySettings,
  GatewayDomain,
  AdminToken,
  CallerKey,
  GITHUB_ORIGINS,
  EgressAllowlist,
} from "@usine/gateway";
import { GatewayAddresses, gatewayLayer } from "@usine/gateway/node";
import { ConfigParser } from "@usine/config/parser";
import { InstancePath } from "@usine/config/file";
import { LoadedInstance } from "@usine/config/instance";
import {
  ConfigurationStore,
  ConfigurationRevisionNumber,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { ProviderLogins } from "../src/providers/control.ts";
import { ProviderLoginRunner } from "../src/providers/runner.ts";
import { ProviderTargets } from "../src/providers/targets.ts";
import { ReleaseVersion } from "@usine/core/upgrade";
import {
  LoginSecret,
  providerEntry,
  type ProviderTarget,
  StaticKey,
} from "@usine/gateway/credentials";

const credentialOf = (connection: ProviderTarget["providers"][number] | undefined) =>
  connection !== undefined && "credential" in connection ? connection.credential : undefined;

/**
 * A provider that only this test defines, with a static key. Its slot differs from its ID, so a
 * test sees which one a credential is keyed by.
 */
const plan = ModelProvider.make({
  id: ModelProviderId.make("test-plan"),
  slot: GatewaySlot.make("test-plan-chat"),
  label: "Test plan",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("openai-chat-completions"),
      upstream: UpstreamBase.make("https://plan.test/v1"),
      routes: [RoutePattern.make("/chat/completions")],
      key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
    }),
  ],
  credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
});

it.live(
  "hands credentials to the gateway admin API and updates routing; uses native files without a gateway",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const settings = GatewaySettings.of({
          domain: GatewayDomain.make("gw.test"),
          github: GITHUB_ORIGINS,
          catalog: ModelProviderCatalog.make({ providers: [...modelProviders.providers, plan] }),
          providers: {},
          upstreams: {},
          adminToken: AdminToken.make(Redacted.make("test-admin-token-private-0123456789")),
          callerKey: CallerKey.make(Redacted.make("test-caller-key-private-0123456789")),
          egress: EgressAllowlist.make({ rules: [] }),
        });
        const listener = { host: "127.0.0.1", port: 0 };
        const gateway = yield* Layer.build(
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            `${directory}/gateway`,
          ).pipe(Layer.provide(Layer.succeed(GatewaySettings, settings))),
        );
        const { admin } = Context.get(gateway, GatewayAddresses);
        const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
        const storeContext = yield* Layer.build(
          memoryConfigurationLayer.pipe(Layer.provideMerge(parserLayer)),
        );
        const parser = Context.get(storeContext, ConfigParser);
        const store = Context.get(storeContext, ConfigurationStore);
        const config = yield* parser.parseUsineYaml(
          InstancePath.make("usine.yaml"),
          `version: 2
operator: operator
repos: []
workers:
  - name: remote
    kind: ssh
    destination: worker
    root: /srv/usine
    gateway:
      domain: gw.test
      destination: test-gateway
      admin_port: ${admin.port}
      admin_token_env: TEST_GATEWAY_ADMIN_TOKEN
${["missing-token", "unreachable", "outdated", "older-gateway"]
  .map(
    (destination) => `  - name: ${destination}
    kind: ssh
    destination: worker-${destination}
    root: /srv/usine
    gateway:
      domain: gw.test
      destination: ${destination}
      admin_port: ${admin.port}
      admin_token_env: ${destination === "missing-token" ? "UNSET_GATEWAY_TOKEN" : "TEST_GATEWAY_ADMIN_TOKEN"}
`,
  )
  .join("")}`,
        );
        const instance = LoadedInstance.make({
          config,
          agents: [],
          loops: [],
          warnings: [],
          invalidAgents: [],
          quarantinedLoops: [],
        });
        yield* store.commit({
          expected: ConfigurationRevisionNumber.make(0),
          changes: configurationDiff([], configurationEntities(instance)),
          actor: Option.none(),
          message: Option.none(),
        });
        yield* fs.writeFileString(
          `${directory}/ssh`,
          "#!/bin/sh\nfor arg do\ncase \"$arg\" in\nunreachable) exit 255;;\noutdated) printf '{}'; exit 0;;\nolder-gateway) cat >/dev/null; printf '\\n404'; exit 22;;\nesac\ndone\nfor last do :; done\nexec sh -c \"$last\"\n",
          { mode: 0o700 },
        );
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const destinations: string[] = [];
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") destinations.push(command.args[5] ?? "");
          return native.spawn(ChildProcess.setEnv(command, { PATH: `${directory}:/usr/bin:/bin` }));
        });
        const targetsLayerWith = (release: Option.Option<ReleaseVersion>) =>
          ProviderTargets.layer(
            store.read.pipe(
              Effect.orDie,
              Effect.map(({ instance }) =>
                Option.isSome(instance) ? instance.value.config.workers : [],
              ),
            ),
            release,
          ).pipe(
            Layer.provide(Layer.succeed(ConfigurationStore, store)),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport)),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  HOME: directory,
                  TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
                }),
              ),
            ),
          );
        const context = yield* Layer.build(targetsLayerWith(Option.none()));
        const targets = Context.get(context, ProviderTargets);
        let starts = 0;
        const loginContext = yield* Layer.build(
          ProviderLogins.layer.pipe(
            Layer.provide([
              Layer.succeed(ProviderTargets, targets),
              Layer.succeed(ProviderLoginRunner, {
                start: () =>
                  Effect.sync(() => {
                    starts += 1;
                    return {
                      prompt: Effect.succeed({
                        url: "https://auth.openai.com/codex/device",
                        code: "ABCD-EFGH",
                      }),
                      result: Effect.never,
                      submit: () => Effect.void,
                    };
                  }),
              }),
            ]),
          ),
        );
        const logins = Context.get(loginContext, ProviderLogins);
        yield* Effect.gen(function* () {
          const status = yield* logins.status;
          assert.lengthOf(status.targets, 5);
          for (const destination of status.targets) {
            if (destination.target === "test-gateway") assert("providers" in destination);
            else assert("error" in destination);
          }
          const older = status.targets.find(({ target }) => target === "older-gateway");
          assert(older !== undefined && "error" in older);
          assert.strictEqual(
            older.error,
            "Gateway older-gateway is older than this orchestrator: it has no provider-credentials admin API. Install the @usine/gateway release that matches this orchestrator on it.",
          );
          const releasedContext = yield* Layer.build(
            targetsLayerWith(Option.some(ReleaseVersion.make("0.3.1"))),
          );
          const released = Context.get(releasedContext, ProviderTargets);
          const named = yield* released.get("older-gateway").pipe(Effect.flip);
          assert.strictEqual(
            named.message,
            "Gateway older-gateway is older than this orchestrator: it has no provider-credentials admin API. Install @usine/gateway@0.3.1 on it.",
          );
          const before = destinations.length;
          const login = yield* logins.begin("test-gateway", "chatgpt");
          yield* Effect.sleep("20 millis");
          assert.equal(starts, 1);
          assert.deepEqual(destinations.slice(before), ["test-gateway"]);
          yield* logins.cancel(login.id);
          for (const target of [
            "missing-token",
            "unreachable",
            "outdated",
            "older-gateway",
            "removed",
            "local",
          ]) {
            const failure = yield* logins.begin(target, "chatgpt").pipe(Effect.flip);
            assert.equal(failure._tag, "ProviderCredentialError");
          }
          assert.equal(starts, 1);
          assert.notInclude(jsonKey(status), Redacted.value(settings.adminToken));
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
            }),
          ),
        );
        const secret = 'private-key-with-"quotes"-and-\\slashes';
        yield* targets
          .replace(
            "test-gateway",
            StaticKey.make({ provider: anthropic.id, secret: Redacted.make(secret) }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
              }),
            ),
          );
        const connected = yield* targets.list.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
            }),
          ),
        );
        assert.equal(
          connected[0] !== undefined && "providers" in connected[0]
            ? credentialOf(connected[0].providers[0])
            : undefined,
          "api-key",
        );
        const snapshot = yield* store.read;
        assert.isTrue(Option.isSome(snapshot.instance));
        if (Option.isSome(snapshot.instance)) {
          const worker = snapshot.instance.value.config.workers[0];
          assert(worker?.kind === "ssh" && Option.isSome(worker.gateway));
          assert.deepEqual(worker.gateway.value.llmProviders, [anthropic.slot]);
        }
        const inForce = Context.get(gateway, SettingsInForce);
        const saved = yield* inForce.current;
        const saved_ = saved.providers[anthropic.slot];
        assert(saved_ !== undefined && saved_.credential._tag === "ApiKey");
        assert.equal(Redacted.value(saved_.credential.key), secret);
        assert.notInclude(jsonKey(connected), secret);
        yield* targets.disconnect("test-gateway", anthropic.slot).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
            }),
          ),
        );
        const removed = yield* targets.list.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
            }),
          ),
        );
        assert.equal(
          removed[0] !== undefined && "providers" in removed[0]
            ? credentialOf(removed[0].providers[0])
            : undefined,
          null,
        );
        const planKey = "plan-key-for-server-tests-0123456789";
        const gatewayToken = ConfigProvider.fromUnknown({
          TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
        });
        yield* logins
          .apiKey("test-gateway", plan.slot, Redacted.make(planKey))
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, gatewayToken));
        const planConnected = yield* targets
          .get("test-gateway")
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, gatewayToken));
        assert.deepStrictEqual(
          planConnected.providers.find(({ provider }) => provider === plan.slot),
          {
            provider: plan.slot,
            id: plan.id,
            label: "Test plan",
            accepts: { apiKey: true, login: null },
            credential: "api-key",
            expiresAt: null,
            lastRefresh: null,
            refreshable: false,
          },
        );
        const planHeld = (yield* inForce.current).providers[plan.slot];
        assert(planHeld !== undefined && planHeld.credential._tag === "ApiKey");
        assert.equal(Redacted.value(planHeld.credential.key), planKey);
        const unrouted = yield* store.read;
        assert(Option.isSome(unrouted.instance));
        const routedWorker = unrouted.instance.value.config.workers[0];
        assert(routedWorker?.kind === "ssh" && Option.isSome(routedWorker.gateway));
        assert.deepEqual(routedWorker.gateway.value.llmProviders, []);
        yield* logins
          .disconnect("test-gateway", plan.id)
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, gatewayToken));
        assert.isUndefined((yield* inForce.current).providers[plan.slot]);
        assert.notInclude(jsonKey(planConnected), planKey);
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* fs.writeFileString(`${directory}/codex`, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        const claudeStatus = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand" || command.command !== "claude")
            return nativeSpawner.spawn(command);
          // Read the saved settings in a subprocess, with the harness's complete environment.
          return nativeSpawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                `
            const fs = require("node:fs");
            const settings = JSON.parse(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + "/settings.json", "utf8"));
            const authMethod = settings.env.CLAUDE_CODE_OAUTH_TOKEN ? "oauth_token" : settings.env.ANTHROPIC_API_KEY ? "api_key" : "none";
            console.log(JSON.stringify({ loggedIn: authMethod !== "none", authMethod, apiProvider: "firstParty" }));
          `,
              ],
              command.options,
            ),
          );
        });
        const localContext = yield* Layer.build(
          ProviderTargets.layer(Effect.succeed([]), Option.none()).pipe(
            Layer.provide(Layer.succeed(ConfigurationStore, store)),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, claudeStatus)),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  HOME: directory,
                  PATH: directory,
                  CLAUDE_CONFIG_DIR: `${directory}/custom claude`,
                  CODEX_HOME: `${directory}/custom codex`,
                }),
              ),
            ),
          ),
        );
        const local = Context.get(localContext, ProviderTargets);
        yield* local.replace(
          "local",
          LoginSecret.make({ login: "claude", secret: Redacted.make("private-claude-token") }),
        );
        yield* local.replace(
          "local",
          StaticKey.make({ provider: openai.id, secret: Redacted.make("private-openai-key") }),
        );
        const nativeSettings = yield* fs.readFileString(`${directory}/custom claude/settings.json`);
        const nativeAuth = yield* fs.readFileString(`${directory}/custom codex/auth.json`);
        const env = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ env: Schema.Struct({ CLAUDE_CODE_OAUTH_TOKEN: Schema.String }) }),
          ),
        )(nativeSettings);
        assert.equal(env.env.CLAUDE_CODE_OAUTH_TOKEN, "private-claude-token");
        assert.include(nativeAuth, "private-openai-key");
        assert.equal((yield* fs.stat(`${directory}/custom codex/auth.json`)).mode & 0o777, 0o600);
        const path = yield* Config.String("PATH");
        const verifyLocalClaude = preflight(
          BrainSpec.make({
            harness: Harness.make("claude"),
            model: ModelId.make("claude-sonnet-4-6"),
            effort: "low",
          }),
          ProbeTarget.make({
            host: LocalProcess.make(),
            environment: {
              HOME: directory,
              CLAUDE_CONFIG_DIR: `${directory}/custom claude`,
              PATH: path,
            },
            placement: "local",
            credential: "host-login",
            worker: WorkerName.make("test-worker"),
            machine: Option.none(),
          }),
        ).pipe(
          Effect.provide(harnessesLive),
          Effect.provideService(HostLoginLock, { withLock: () => (effect) => effect }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, claudeStatus),
        );
        assert.equal((yield* verifyLocalClaude)._tag, "HarnessReady");
        yield* local.replace(
          "local",
          StaticKey.make({ provider: anthropic.id, secret: Redacted.make("fixture-api-key") }),
        );
        assert.equal((yield* verifyLocalClaude)._tag, "HarnessReady");
        yield* local.disconnect("local", anthropic.slot);
        assert.equal((yield* verifyLocalClaude)._tag, "HarnessUnavailableError");
        yield* local.disconnect("local", openai.slot);
        const empty = yield* local.list;
        assert.deepEqual(
          empty[0] !== undefined && "providers" in empty[0]
            ? empty[0].providers.map(credentialOf)
            : undefined,
          [null, null],
        );
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live("manages ChatGPT on a local host without Claude Code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const store = yield* ConfigurationStore;
      const targetsContext = yield* Layer.build(
        ProviderTargets.layer(Effect.succeed([]), Option.none()).pipe(
          Layer.provide(Layer.succeed(ConfigurationStore, store)),
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ HOME: directory, PATH: directory }),
            ),
          ),
        ),
      );
      const targets = Context.get(targetsContext, ProviderTargets);
      let starts = 0;
      const loginContext = yield* Layer.build(
        ProviderLogins.layer.pipe(
          Layer.provide([
            Layer.succeed(ProviderTargets, targets),
            Layer.succeed(ProviderLoginRunner, {
              start: () =>
                Effect.sync(() => {
                  starts += 1;
                  return {
                    prompt: Effect.succeed({
                      url: "https://auth.openai.com/codex/device",
                      code: "ABCD-EFGH",
                    }),
                    result: Effect.never,
                    submit: () => Effect.void,
                  };
                }),
            }),
          ]),
        ),
      );
      const logins = Context.get(loginContext, ProviderLogins);
      const unavailable = yield* logins.begin("local", "chatgpt").pipe(Effect.flip);
      assert.equal(unavailable.message, "Codex not found on PATH. Install it to connect ChatGPT.");
      assert.equal(starts, 0);
      yield* fs.writeFileString(`${directory}/codex`, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const providers = Effect.map(logins.status, ({ targets: [local] }) => {
        assert(local !== undefined && "providers" in local);
        const [claude, chatgpt] = local.providers;
        assert(claude !== undefined && "error" in claude);
        assert.equal(claude.provider, "anthropic-messages");
        assert.include(claude.error, "Claude Code not found on PATH");
        assert(chatgpt !== undefined && "credential" in chatgpt);
        return chatgpt;
      });
      const initial = yield* providers;
      assert.deepEqual(initial, {
        provider: openai.slot,
        ...providerEntry(openai),
        credential: null,
        expiresAt: null,
        lastRefresh: null,
      });

      const login = yield* logins.begin("local", "chatgpt");
      yield* Effect.sleep("20 millis");
      assert.equal(starts, 1);
      yield* logins.cancel(login.id);
      const refused = yield* logins.begin("local", "claude").pipe(Effect.flip);
      assert.include(refused.message, "Claude Code not found on PATH");
      assert.equal(starts, 1);

      yield* logins.apiKey("local", "chatgpt", Redacted.make("fixture-openai-key"));
      const connected = yield* providers;
      assert.equal(connected.credential, "api-key");
      assert.notInclude(jsonKey(connected), "fixture-openai-key");
      yield* logins.disconnect("local", "chatgpt");
      assert.equal((yield* providers).credential, null);

      // A key or a disconnect replaces an auth file that the status can't read.
      const authFile = `${directory}/.codex/auth.json`;
      yield* fs.makeDirectory(`${directory}/.codex`, { recursive: true });
      yield* fs.writeFileString(authFile, "{malformed");
      yield* logins.apiKey("local", "openai", Redacted.make("fixture-repaired-key"));
      const repaired = yield* fs.readFileString(authFile);
      assert.include(repaired, "fixture-repaired-key");
      yield* fs.writeFileString(authFile, "{malformed");
      yield* logins.disconnect("local", "openai");
      const left = yield* fs.exists(authFile);
      assert.isFalse(left);
    }),
  ).pipe(
    Effect.provide(
      memoryConfigurationLayer.pipe(
        Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.live("logs local provider availability changes once at info across repeated polls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${directory}/codex`, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const store = yield* ConfigurationStore;
      const context = yield* Layer.build(
        ProviderTargets.layer(Effect.succeed([]), Option.none()).pipe(
          Layer.provide(Layer.succeed(ConfigurationStore, store)),
          Layer.provide(
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ HOME: directory, PATH: directory }),
            ),
          ),
        ),
      );
      const targets = Context.get(context, ProviderTargets);
      const logged: Array<{ level: string; message: unknown }> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        logged.push({ level: logLevel, message });
      });
      yield* Effect.gen(function* () {
        yield* targets.list;
        yield* targets.list;
        assert.lengthOf(logged, 1);
        assert.equal(logged[0]?.level, "Info");
        assert.include(jsonKey(logged), "Claude Code not found on PATH");

        yield* fs.writeFileString(`${directory}/claude`, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
        yield* targets.list;
        yield* targets.list;
        assert.lengthOf(logged, 2);
        assert.include(jsonKey(logged[1]), "Claude authentication command failed");

        yield* fs.writeFileString(
          `${directory}/claude`,
          '#!/bin/sh\nprintf \'%s\' \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\'\n',
          { mode: 0o700 },
        );
        yield* targets.list;
        yield* targets.list;
        assert.lengthOf(logged, 3);
        assert.include(jsonKey(logged[2]), "Local provider status available");

        yield* fs.remove(`${directory}/claude`);
        yield* targets.list;
        yield* targets.list;
        assert.lengthOf(logged, 4);
        assert.include(jsonKey(logged[3]), "Claude Code not found on PATH");
        assert.isTrue(logged.every(({ level }) => level === "Info"));
      }).pipe(Effect.provide(Logger.layer([logger])));
    }),
  ).pipe(
    Effect.provide(
      memoryConfigurationLayer.pipe(
        Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
