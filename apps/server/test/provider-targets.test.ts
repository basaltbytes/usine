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
  - name: remote
    kind: ssh
    destination: worker
    root: /srv/usine
    gateway:
      domain: gw.test
      destination: test-gateway
      admin_port: ${admin.port}
      admin_token_env: TEST_GATEWAY_ADMIN_TOKEN
${["missing-token", "unreachable", "outdated"]
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
          '#!/bin/sh\nfor arg do\ncase "$arg" in\nunreachable) exit 255;;\noutdated) printf \'{}\'; exit 0;;\nesac\ndone\nfor last do :; done\nexec sh -c "$last"\n',
          { mode: 0o700 },
        );
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const destinations: string[] = [];
        const transport = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") destinations.push(command.args[5] ?? "");
          return native.spawn(ChildProcess.setEnv(command, { PATH: `${directory}:/usr/bin:/bin` }));
        });
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
          assert.lengthOf(status.targets, 4);
          for (const destination of status.targets) {
            if (destination.target === "test-gateway") assert("providers" in destination);
            else assert("error" in destination);
          }
          const before = destinations.length;
          const login = yield* logins.begin("test-gateway", "chatgpt");
          yield* Effect.sleep("20 millis");
          assert.equal(starts, 1);
          assert.deepEqual(destinations.slice(before), ["test-gateway"]);
          yield* logins.cancel(login.id);
          for (const target of ["missing-token", "unreachable", "outdated", "removed", "local"]) {
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
        assert.equal(
          connected[0] !== undefined && "providers" in connected[0]
            ? connected[0].providers[0]?.credential
            : undefined,
          "api-key",
        );
        const snapshot = yield* store.read;
        assert.isTrue(Option.isSome(snapshot.instance));
        if (Option.isSome(snapshot.instance)) {
          const worker = snapshot.instance.value.config.workers[0];
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
        assert.equal(
          removed[0] !== undefined && "providers" in removed[0]
            ? removed[0].providers[0]?.credential
            : undefined,
          null,
        );
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
          ProviderTargets.layer(Effect.succeed([])).pipe(
            Layer.provide(Layer.succeed(ConfigurationStore, store)),
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, claudeStatus)),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  HOME: directory,
                  CLAUDE_CONFIG_DIR: `${directory}/custom claude`,
                  CODEX_HOME: `${directory}/custom codex`,
                }),
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
        yield* local.replace("local", {
          kind: "anthropic-api-key",
          secret: Redacted.make("fixture-api-key"),
        });
        assert.equal((yield* verifyLocalClaude)._tag, "HarnessReady");
        yield* local.disconnect("local", "anthropic");
        assert.equal((yield* verifyLocalClaude)._tag, "HarnessUnavailableError");
        yield* local.disconnect("local", "openai");
        const empty = yield* local.list;
        assert.deepEqual(
          empty[0] !== undefined && "providers" in empty[0]
            ? empty[0].providers.map(({ credential }) => credential)
            : undefined,
          [null, null],
        );
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
