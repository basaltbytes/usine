import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
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
import { ProviderTargets } from "../src/providers/targets.ts";
import { ProviderLogins } from "../src/providers/control.ts";
import { ProviderLoginRunner } from "../src/providers/runner.ts";

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
          providers: { anthropic: Option.none(), openai: Option.none() },
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
  - name: unavailable
    kind: ssh
    destination: unavailable-worker
    root: /srv/usine
    gateway:
      domain: unavailable.test
      destination: unavailable-gateway
      admin_token_env: MISSING_GATEWAY_ADMIN_TOKEN
  - name: remote
    kind: ssh
    destination: worker
    root: /srv/usine
    gateway:
      domain: gw.test
      destination: test-gateway
      admin_port: ${admin.port}
      admin_token_env: TEST_GATEWAY_ADMIN_TOKEN
`,
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
          '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n',
          { mode: 0o700 },
        );
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const transport = ChildProcessSpawner.make((command) =>
          native.spawn(ChildProcess.setEnv(command, { PATH: `${directory}:/usr/bin:/bin` })),
        );
        const targetsLayer = ProviderTargets.layer(
          store.read.pipe(
            Effect.orDie,
            Effect.map(({ instance }) =>
              Option.isSome(instance) ? instance.value.config.workers : [],
            ),
          ),
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
        const context = yield* Layer.build(targetsLayer);
        const targets = Context.get(context, ProviderTargets);
        const secret = 'private-key-with-"quotes"-and-\\slashes';
        yield* targets
          .replace("test-gateway", { kind: "anthropic-api-key", secret: Redacted.make(secret) })
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
        assert.include(connected[0], {
          target: "unavailable-gateway",
          error: "Set MISSING_GATEWAY_ADMIN_TOKEN to the gateway admin token.",
        });
        const healthy = connected[1];
        assert(healthy !== undefined && "providers" in healthy);
        assert.equal(healthy.providers[0]?.credential, "api-key");
        const loginContext = yield* Layer.build(
          ProviderLogins.layer.pipe(
            Layer.provide(Layer.succeed(ProviderTargets, targets)),
            Layer.provide(
              Layer.succeed(ProviderLoginRunner, {
                start: () =>
                  Effect.succeed({
                    prompt: Effect.never,
                    result: Effect.never,
                    submit: () => Effect.void,
                  }),
              }),
            ),
          ),
        );
        const logins = Context.get(loginContext, ProviderLogins);
        const login = yield* logins.begin("test-gateway", "claude").pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              TEST_GATEWAY_ADMIN_TOKEN: Redacted.value(settings.adminToken),
            }),
          ),
        );
        assert.equal(login.target, "test-gateway");
        yield* logins.cancel(login.id);
        const snapshot = yield* store.read;
        assert.isTrue(Option.isSome(snapshot.instance));
        if (Option.isSome(snapshot.instance)) {
          const worker = snapshot.instance.value.config.workers[1];
          assert(worker?.kind === "ssh" && Option.isSome(worker.gateway));
          assert.deepEqual(worker.gateway.value.llmProviders, ["anthropic"]);
        }
        const inForce = Context.get(gateway, SettingsInForce);
        const saved = yield* inForce.current;
        assert(Option.isSome(saved.providers.anthropic));
        assert(saved.providers.anthropic.value.credential._tag === "AnthropicApiKey");
        assert.equal(Redacted.value(saved.providers.anthropic.value.credential.key), secret);
        assert.notInclude(jsonKey(connected), secret);
        yield* targets.disconnect("test-gateway", "anthropic").pipe(
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
        const disconnected = removed[1];
        assert(disconnected !== undefined && "providers" in disconnected);
        assert.equal(disconnected.providers[0]?.credential, null);
        const localContext = yield* Layer.build(
          ProviderTargets.layer(Effect.succeed([])).pipe(
            Layer.provide(Layer.succeed(ConfigurationStore, store)),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ HOME: directory }),
              ),
            ),
          ),
        );
        const local = Context.get(localContext, ProviderTargets);
        yield* local.replace("local", {
          kind: "claude-subscription",
          secret: Redacted.make("private-claude-token"),
        });
        yield* local.replace("local", {
          kind: "openai-api-key",
          secret: Redacted.make("private-openai-key"),
        });
        const nativeSettings = yield* fs.readFileString(`${directory}/.claude/settings.json`);
        const nativeAuth = yield* fs.readFileString(`${directory}/.codex/auth.json`);
        const env = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ env: Schema.Struct({ CLAUDE_CODE_OAUTH_TOKEN: Schema.String }) }),
          ),
        )(nativeSettings);
        assert.equal(env.env.CLAUDE_CODE_OAUTH_TOKEN, "private-claude-token");
        assert.include(nativeAuth, "private-openai-key");
        assert.equal((yield* fs.stat(`${directory}/.codex/auth.json`)).mode & 0o777, 0o600);
        yield* local.disconnect("local", "anthropic");
        yield* local.disconnect("local", "openai");
        const empty = yield* local.list;
        const localTarget = empty[0];
        assert(localTarget !== undefined && "providers" in localTarget);
        assert.deepEqual(
          localTarget.providers.map(({ credential }) => credential),
          [null, null],
        );
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
