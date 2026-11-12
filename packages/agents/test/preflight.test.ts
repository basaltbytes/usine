import { Harnesses, harnessesLayer, hostPlacement, ProbeTarget } from "../src/harness/node.ts";
import type { CredentialRoute, Placement } from "../src/harness/capability.ts";
import { claudeSdkLive } from "../src/harness/claude/sdk.ts";
import { HostLoginLock } from "../src/runtime.ts";
import { WorkerName } from "@usine/core/worker";
import { catalog } from "../src/harness/catalog.ts";
import { jsonKey } from "@usine/core/json-key";
// Fetch and agent SDK interfaces require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, describe, it } from "@effect/vitest";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LocalProcess, RemoteShell } from "../src/child-host/child-host.ts";
import { CodexAppServer, type CodexConnection } from "../src/harness/codex/app-server.ts";
import { PiSdk, type PiStartOptions, type PiStartResult } from "../src/harness/pi/sdk.ts";
import { probeOutput } from "../src/preflight/command.ts";
import { CODEX_CLI_VERSION } from "../src/preflight/preflight.ts";
import packageJson from "../package.json" with { type: "json" };

/** Fails a Pi completion that the test doesn't expect. */
const noCompletion = () => Promise.reject(new Error("The test runs no completion"));

const verifyHarness = (
  brain: BrainSpec,
  host: typeof local | typeof remote,
  environment: Readonly<Record<string, string>>,
  credential: CredentialRoute = "host-login",
  placement: Placement = hostPlacement(host),
) =>
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const runtime = yield* harnesses.runtime(brain.harness);
    const readiness = yield* runtime.preflight(
      brain,
      ProbeTarget.make({
        host,
        environment,
        placement,
        credential,
        worker: WorkerName.make("test-worker"),
        machine: Option.none(),
      }),
    );
    return readiness._tag === "HarnessUnavailableError" ? yield* readiness : readiness;
  }).pipe(
    Effect.provide(
      harnessesLayer.pipe(
        Layer.provide(claudeSdkLive),
        Layer.provide(Layer.succeed(HostLoginLock)({ withLock: () => (effect) => effect })),
      ),
    ),
  );

/** The Claude Code version that the installed Claude Agent SDK bundles. */
const claudeVersion = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ claudeCodeVersion: Schema.String })),
)(
  readFileSync(
    new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url),
    "utf8",
  ),
);

const brain = (harness: BrainSpec["harness"]) =>
  BrainSpec.make({ harness, model: ModelId.make("provider/model"), effort: "low" });
const coder = brain(Harness.make("codex"));
const local = LocalProcess.make();
const remote = RemoteShell.make({
  ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
  sshEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  destination: "worker.exe.xyz",
});
const overSsh = (line: string) => `ssh -o BatchMode=yes worker.exe.xyz -- ${line}`;
/** The environment for local checks, used instead of the test process's environment. */
const workerEnvironment = { PATH: "/usr/bin:/bin" };
const encoder = new TextEncoder();
const codexVersionCommand =
  "codex -c features.multi_agent=false -c features.plugins=false -c features.remote_plugin=false -c features.apps=false -c check_for_update_on_startup=false -c analytics.enabled=false --version";

const commands = (
  responses: Readonly<Record<string, { readonly stdout: string; readonly exitCode: number }>>,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.strictEqual(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        assert.deepStrictEqual(
          command.options.env,
          command.command === "ssh" ? remote.sshEnvironment : workerEnvironment,
        );
        assert.strictEqual(command.options.extendEnv, false);
        const key = [command.command, ...command.args].join(" ");
        const response = responses[key];
        assert(response !== undefined, `unexpected command ${key}`);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(response.stdout)),
          stderr: Stream.make(encoder.encode("credential-shaped diagnostic must not escape")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

const claudeCommands = (
  responses: Readonly<Record<string, { readonly stdout: string; readonly exitCode: number }>>,
) =>
  Layer.unwrap(
    Effect.map(claudeVersion, ({ claudeCodeVersion }) =>
      commands({
        "claude --version": { stdout: `${claudeCodeVersion} (Claude Code)`, exitCode: 0 },
        ...responses,
      }),
    ),
  );

const account = (response: Effect.Effect<Schema.Json>) => {
  let opened = 0;
  let closed = 0;
  const layer = Layer.succeed(CodexAppServer)({
    stop: () => Effect.void,
    open: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          opened += 1;
          return {
            close: Effect.void,
            notifications: Stream.empty,
            notify: (_operation, method) =>
              Effect.sync(() => assert.strictEqual(method, "initialized")),
            request: (_operation, method) => {
              if (method === "initialize") return Effect.succeed({});
              assert.strictEqual(method, "account/read", "preflight must not start agent work");
              return response;
            },
          } satisfies CodexConnection;
        }),
        () =>
          Effect.sync(() => {
            closed += 1;
          }),
      ),
  });
  return { layer, opened: () => opened, closed: () => closed };
};
const unusedAccount = account(Effect.die("the probe must not inspect an account")).layer;

const unusedPi = Layer.succeed(PiSdk)({
  complete: noCompletion,
  start: async () => {
    throw new Error("Pi must not start for another harness");
  },
});

describe("worker harness readiness", () => {
  it("checks the same Codex version as the protocol conformance gate", () => {
    assert.strictEqual(
      CODEX_CLI_VERSION,
      packageJson.devDependencies["@pwrdrvr/codex-app-server-protocol"],
    );
  });

  // turbo.json lists the cloud-init file as an input of this package's tests.
  const cloudInitPins = (pattern: RegExp) =>
    [
      ...readFileSync(
        new URL("../../../infra/hetzner/cloud-init.yaml", import.meta.url),
        "utf8",
      ).matchAll(pattern),
    ].map(([, version]) => version);

  it("pins the Codex conformance baseline in the Hetzner worker image", () => {
    const pins = cloudInitPins(/@openai\/codex@(\S+)/gu);
    assert.deepStrictEqual(pins, [CODEX_CLI_VERSION]);
    assert.deepStrictEqual(
      catalog.descriptors.flatMap(({ worker }) =>
        worker.install.filter(({ name }) => name === "@openai/codex").map(({ version }) => version),
      ),
      pins,
    );
  });

  it.effect("pins the Claude Agent SDK's Claude Code version in the Hetzner worker image", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(cloudInitPins(/@anthropic-ai\/claude-code@(\S+)/gu), [
        (yield* claudeVersion).claudeCodeVersion,
      ]);
      assert.deepStrictEqual(
        catalog.descriptors.flatMap(({ worker }) =>
          worker.install
            .filter(({ name }) => name === "@anthropic-ai/claude-code")
            .map(({ version }) => version),
        ),
        [(yield* claudeVersion).claudeCodeVersion],
      );
    }),
  );

  // turbo.json lists the Dockerfile as an input too.
  const argument = (name: string) =>
    [
      ...readFileSync(
        new URL("../../../infra/worker-image/Dockerfile", import.meta.url),
        "utf8",
      ).matchAll(new RegExp(`^ARG ${name}=(\\S+)$`, "gmu")),
    ].map(([, value]) => value);

  it("pins the attempt container image's pnpm at the Hetzner worker version", () => {
    assert.deepStrictEqual(argument("PNPM_VERSION"), cloudInitPins(/pnpm@(\S+)/gu));
  });

  // turbo.json lists the script as an input too.
  it("renders the Hetzner worker's cloud-init with the attempt image's Node.js major version", () => {
    const rendered = execFileSync(
      "sh",
      [
        fileURLToPath(new URL("../../../infra/hetzner/render-cloud-init.sh", import.meta.url)),
        "[]",
      ],
      { encoding: "utf8" },
    );
    assert.deepStrictEqual(
      [...rendered.matchAll(/deb\.nodesource\.com\/node_(\S+)\.x/gu)].map(([, major]) => major),
      argument("NODE_MAJOR"),
    );
  });

  for (const result of [
    { stdout: "", exitCode: 127, capability: "binary" },
    { stdout: "codex-cli 0.144.0", exitCode: 0, capability: "version" },
    { stdout: "codex-cli 0.153.4", exitCode: 0, capability: "version" },
  ]) {
    it.effect(
      `refuses a Codex ${result.capability} gap (${result.stdout || "missing binary"}) before any account request`,
      () => {
        const server = account(Effect.succeed(null));
        return Effect.gen(function* () {
          const error = yield* verifyHarness(coder, local, workerEnvironment).pipe(Effect.flip);
          const matchesError = Schema.is(HarnessUnavailableError)(error);
          assert(matchesError);
          assert.strictEqual(error.capability, result.capability);
          assert.strictEqual(server.opened(), 0);
          assert(!jsonKey(error).includes("credential-shaped"));
        }).pipe(
          Effect.provide(
            commands({ [codexVersionCommand]: result }).pipe(
              Layer.provideMerge(server.layer),
              Layer.provideMerge(unusedPi),
            ),
          ),
        );
      },
    );
  }

  for (const version of ["0.164.0", "0.159.0", "0.159.1", "0.159.2", "0.159.3"]) {
    for (const auth of [{ type: "apiKey" }, { type: "chatgpt" }]) {
      it.effect(
        `checks Codex ${version} ${auth.type} authentication and closes its unprompted connection`,
        () => {
          const server = account(Effect.succeed({ account: auth, requiresOpenaiAuth: true }));
          return Effect.gen(function* () {
            const available = yield* verifyHarness(coder, local, workerEnvironment);
            assert.deepStrictEqual(
              available,
              HarnessReady.make({ harness: Harness.make("codex") }),
            );
            assert.strictEqual(server.opened(), 1);
            assert.strictEqual(server.closed(), 1);
          }).pipe(
            Effect.provide(
              commands({
                [codexVersionCommand]: { stdout: `codex-cli ${version}`, exitCode: 0 },
              }).pipe(Layer.provideMerge(server.layer), Layer.provideMerge(unusedPi)),
            ),
          );
        },
      );
    }
  }

  it.effect("closes a stalled account probe without declaring the login unavailable", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const server = account(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const pending = yield* verifyHarness(coder, local, workerEnvironment).pipe(
        Effect.flip,
        Effect.provide(
          commands({
            [codexVersionCommand]: { stdout: `codex-cli ${CODEX_CLI_VERSION}`, exitCode: 0 },
          }).pipe(Layer.provideMerge(server.layer), Layer.provideMerge(unusedPi)),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");

      assert.strictEqual((yield* Fiber.join(pending))._tag, "SessionOperationError");
      assert.strictEqual(server.closed(), 1);
    }),
  );

  const subscriptionLogin =
    "Claude Code needs a subscription login or API key. Run claude auth login on the worker.";
  // Claude Code 2.1.308 prints its status and exits 1 when not logged in.
  for (const status of [
    {
      auth: {
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
        analyticsDisabled: false,
        projectsDirectory: "/home/worker/.claude/projects",
        configDirectory: "/home/worker/.claude",
      },
      exitCode: 1,
    },
    { auth: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, exitCode: 0 },
    { auth: { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, exitCode: 0 },
    { auth: { loggedIn: true, authMethod: "unknown", apiProvider: "firstParty" }, exitCode: 0 },
    { auth: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, exitCode: 0 },
    { auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, exitCode: 0 },
  ]) {
    it.effect(
      `checks Claude ${status.auth.authMethod} login exiting ${status.exitCode} without probing Codex or Pi`,
      () => {
        const server = account(Effect.succeed(null));
        return Effect.gen(function* () {
          if (["claude.ai", "oauth_token", "api_key"].includes(status.auth.authMethod)) {
            const available = yield* verifyHarness(
              brain(Harness.make("claude")),
              local,
              workerEnvironment,
            );
            assert.deepStrictEqual(
              available,
              HarnessReady.make({ harness: Harness.make("claude") }),
            );
          } else {
            const error = yield* verifyHarness(
              brain(Harness.make("claude")),
              local,
              workerEnvironment,
            ).pipe(Effect.flip);
            const matchesError = Schema.is(HarnessUnavailableError)(error);
            assert(matchesError);
            assert.strictEqual(error.capability, "login");
            assert.strictEqual(error.message, subscriptionLogin);
          }
          assert.strictEqual(server.opened(), 0);
        }).pipe(
          Effect.provide(
            claudeCommands({
              "claude auth status --json": {
                stdout: jsonKey(status.auth),
                exitCode: status.exitCode,
              },
            }).pipe(Layer.provideMerge(server.layer), Layer.provideMerge(unusedPi)),
          ),
        );
      },
    );
  }

  for (const status of [
    { stdout: "", exitCode: 1 },
    { stdout: "not a status", exitCode: 1 },
    {
      stdout: jsonKey({ loggedIn: false }),
      exitCode: 2,
    },
  ])
    it.effect(
      `reports a Claude login check exiting ${status.exitCode} with ${status.stdout === "" ? "no output" : "unexpected output"} as a failed command`,
      () =>
        Effect.gen(function* () {
          const error = yield* verifyHarness(
            brain(Harness.make("claude")),
            local,
            workerEnvironment,
          ).pipe(Effect.flip);
          const matchesError = Schema.is(HarnessUnavailableError)(error);
          assert(matchesError);
          assert.strictEqual(error.capability, "login");
          assert.strictEqual(
            error.message,
            "claude auth status --json failed. Check the claude installation and login on the worker.",
          );
        }).pipe(
          Effect.provide(
            claudeCommands({
              "claude auth status --json": status,
            }).pipe(
              Layer.provideMerge(account(Effect.succeed(null)).layer),
              Layer.provideMerge(unusedPi),
            ),
          ),
        ),
    );

  for (const pool of ["apiKeys", "chatgptPlan"] as const) {
    it.effect(`checks Pi ${pool} authentication and disposes its unprompted SDK session`, () => {
      let disposed = 0;
      let options: PiStartOptions | undefined;
      const piBrain = BrainSpec.make({
        ...brain(Harness.make("pi")),
        model: ModelId.make(
          pool === "chatgptPlan" ? "openai-codex/gpt-5.6-sol" : "openai/gpt-5.6-sol",
        ),
      });
      const started: PiStartResult = {
        _tag: "Started",
        harnessSession: Option.none(),
        model: piBrain.model,
        pool,
        tools: [],
        session: {
          messages: [],
          subscribe: () => () => {},
          prompt: async () => {
            throw new Error("preflight must never prompt");
          },
          steer: async () => {},
          abort: async () => {},
          dispose: () => {
            disposed += 1;
          },
        },
      };
      return Effect.gen(function* () {
        const available = yield* verifyHarness(piBrain, local, workerEnvironment);
        assert.deepStrictEqual(available, HarnessReady.make({ harness: Harness.make("pi") }));
        assert.strictEqual(disposed, 1);
        assert.strictEqual(options?.model, piBrain.model);
        assert.deepStrictEqual(options?.storage, { _tag: "InMemory" });
        // The session's bash tool would run with the worker's environment, not this process's.
        assert.deepStrictEqual(options?.environment, Option.some(workerEnvironment));
      }).pipe(
        Effect.provide(
          commands({}).pipe(
            Layer.provideMerge(account(Effect.succeed(null)).layer),
            Layer.provideMerge(
              Layer.succeed(PiSdk)({
                complete: noCompletion,
                start: async (received) => {
                  options = received;
                  return started;
                },
              }),
            ),
          ),
        ),
      );
    });
  }

  it.effect("refuses a Pi OAuth provider without a billing pool", () =>
    Effect.gen(function* () {
      const piBrain = BrainSpec.make({
        ...brain(Harness.make("pi")),
        model: ModelId.make("github-copilot/gpt-5.6-sol"),
      });
      const error = yield* verifyHarness(piBrain, local, workerEnvironment).pipe(Effect.flip);
      const matchesError = Schema.is(HarnessUnavailableError)(error);
      assert(matchesError);
      assert.strictEqual(error.capability, "login");
    }).pipe(
      Effect.provide(
        commands({}).pipe(
          Layer.provideMerge(account(Effect.succeed(null)).layer),
          Layer.provideMerge(
            Layer.succeed(PiSdk)({
              complete: noCompletion,
              start: async ({ model }) => ({
                _tag: "UnsupportedAuthentication",
                model,
                authentication: { _tag: "OAuth", subscription: true },
              }),
            }),
          ),
        ),
      ),
    ),
  );

  for (const [credential, sandbox] of [
    ["host-login", false],
    ["gateway", false],
    ["api-key", false],
    ["api-key", true],
  ] as const) {
    const route = sandbox ? "sandbox api-key" : credential;
    it.effect(`reports the Claude Code installation for the ${route} route`, () =>
      Effect.gen(function* () {
        const error = yield* verifyHarness(
          brain(Harness.make("claude")),
          local,
          workerEnvironment,
          credential,
          sandbox ? "sandbox" : "local",
        ).pipe(Effect.flip);
        assert.strictEqual(error._tag, "HarnessUnavailableError");
        assert.strictEqual(
          error.message,
          sandbox
            ? "claude --version failed in the sandbox image. Check the Claude Code installation in the sandbox image."
            : `claude --version failed. Check the Claude Code installation${credential === "host-login" ? " and login" : ""} on the worker.`,
        );
      }).pipe(
        Effect.provide(
          commands({ "claude --version": { stdout: "", exitCode: 127 } }).pipe(
            Layer.provideMerge(unusedAccount),
            Layer.provideMerge(unusedPi),
          ),
        ),
      ),
    );
    if (credential === "host-login") continue;
    it.effect(`reports the Node.js requirement for the ${route} route`, () =>
      Effect.gen(function* () {
        const error = yield* verifyHarness(
          coder,
          remote,
          {},
          credential,
          sandbox ? "sandbox" : "ssh",
        ).pipe(Effect.flip);
        assert.strictEqual(error._tag, "HarnessUnavailableError");
        assert.strictEqual(
          error.message,
          sandbox
            ? "node --version failed in the sandbox image. Check the Codex installation in the sandbox image."
            : "Remote Codex children require Node.js on the worker's command path.",
        );
      }).pipe(
        Effect.provide(
          commands({ [overSsh("exec 'node' '--version'")]: { stdout: "", exitCode: 127 } }).pipe(
            Layer.provideMerge(unusedAccount),
            Layer.provideMerge(unusedPi),
          ),
        ),
      ),
    );
  }

  for (const credential of ["gateway", "api-key"] as const) {
    for (const harness of ["claude", "codex"] as const) {
      it.effect(`checks remote ${harness} without a host login on the ${credential} route`, () => {
        const server = account(Effect.die("external credentials must not inspect a host account"));
        const selected = brain(Harness.make(harness));
        return Effect.gen(function* () {
          const ready = yield* verifyHarness(selected, remote, {}, credential);
          assert.strictEqual(ready._tag, "HarnessReady");
          assert.strictEqual(server.opened(), 0);
        }).pipe(
          Effect.provide(
            commands({
              [overSsh("exec 'node' '--version'")]: { stdout: "v24.0.0", exitCode: 0 },
              [overSsh("exec 'claude' '--version'")]: { stdout: "any Claude version", exitCode: 0 },
              [overSsh(
                "exec 'codex' " +
                  codexVersionCommand
                    .slice("codex ".length)
                    .split(" ")
                    .map((arg) => `'${arg}'`)
                    .join(" "),
              )]: { stdout: `codex-cli ${CODEX_CLI_VERSION}`, exitCode: 0 },
            }).pipe(Layer.provideMerge(server.layer), Layer.provideMerge(unusedPi)),
          ),
        );
      });
    }
  }

  it.effect("refuses remote Codex when its supervisor cannot run Node.js", () =>
    Effect.gen(function* () {
      const error = yield* verifyHarness(coder, remote, {}).pipe(Effect.flip);
      assert.strictEqual(error._tag, "HarnessUnavailableError");
      assert.match(error.message, /node --version failed/u);
    }).pipe(
      Effect.provide(
        commands({ [overSsh("exec 'node' '--version'")]: { stdout: "", exitCode: 127 } }).pipe(
          Layer.provideMerge(account(Effect.succeed({})).layer),
          Layer.provideMerge(unusedPi),
        ),
      ),
    ),
  );

  it.effect("checks Claude on a remote host through one SSH command per probe", () =>
    Effect.gen(function* () {
      return yield* Effect.gen(function* () {
        const available = yield* verifyHarness(brain(Harness.make("claude")), remote, {});
        assert.deepStrictEqual(available, HarnessReady.make({ harness: Harness.make("claude") }));
      }).pipe(
        Effect.provide(
          commands({
            [overSsh("exec 'node' '--version'")]: { stdout: "v22.0.0", exitCode: 0 },
            [overSsh("exec 'claude' '--version'")]: {
              stdout: `${(yield* claudeVersion).claudeCodeVersion} (Claude Code)`,
              exitCode: 0,
            },
            [overSsh("exec 'claude' 'auth' 'status' '--json'")]: {
              stdout: jsonKey({
                loggedIn: true,
                authMethod: "claude.ai",
                apiProvider: "firstParty",
              }),
              exitCode: 0,
            },
          }).pipe(
            Layer.provideMerge(account(Effect.succeed(null)).layer),
            Layer.provideMerge(unusedPi),
          ),
        ),
      );
    }),
  );

  it.effect(
    "reports an unreachable remote host as an incomplete check, not a missing harness",
    () =>
      Effect.gen(function* () {
        const error = yield* verifyHarness(brain(Harness.make("claude")), remote, {}).pipe(
          Effect.flip,
        );
        assert.strictEqual(error._tag, "SessionOperationError");
      }).pipe(
        Effect.provide(
          commands({ [overSsh("exec 'node' '--version'")]: { stdout: "", exitCode: 255 } }).pipe(
            Layer.provideMerge(account(Effect.succeed(null)).layer),
            Layer.provideMerge(unusedPi),
          ),
        ),
      ),
  );

  it.effect("refuses Pi on a remote host without starting the SDK", () =>
    Effect.gen(function* () {
      const error = yield* verifyHarness(brain(Harness.make("pi")), remote, {}).pipe(Effect.flip);
      const matchesError = Schema.is(HarnessUnavailableError)(error);
      assert(matchesError);
      assert.include(error.message, "pi cannot run as coding-agent at ssh: lacks ssh");
    }).pipe(
      Effect.provide(
        commands({}).pipe(
          Layer.provideMerge(account(Effect.succeed(null)).layer),
          Layer.provideMerge(unusedPi),
        ),
      ),
    ),
  );

  it.effect("refuses an environment for a remote readiness command before running it", () =>
    Effect.gen(function* () {
      const exit = yield* probeOutput(
        remote,
        { GH_HOST: "github.example" },
        Harness.make("codex"),
        "binary",
        "codex",
        ["--version"],
      ).pipe(Effect.exit);
      assert(Exit.isFailure(exit));
      const defect = Cause.squash(exit.cause);
      assert(defect instanceof Error);
      assert.strictEqual(
        defect.message,
        "Cannot pass GH_HOST to a remote command on its command line",
      );
    }).pipe(Effect.provide(commands({}))),
  );
});
