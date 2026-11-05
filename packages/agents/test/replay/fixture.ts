import { assert } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { childPidFile, LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { claudeChildLayer } from "../../src/harness/claude/claude.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { ClaudeSdk, claudeSdkLive } from "../../src/harness/claude/sdk.ts";
import { codexChildLayer } from "../../src/harness/codex/codex.ts";
import { codexAppServerLive } from "../../src/harness/codex/app-server.ts";
import { ChildBackend, ChildRequest, HostLoginLock, WorkingDirectory } from "../../src/runtime.ts";
import { claudeTransport } from "./claude.ts";
import { processTransport } from "./process.ts";
import { type Scenario, Tape, Transcript } from "./transcript.ts";

export type Provider = "claude" | "codex";
export const providers: ReadonlyArray<Provider> = ["claude", "codex"];
export const scenarios: ReadonlyArray<Scenario> = [
  "simple",
  "steer",
  "queued-message",
  "interrupt-guidance",
  "hold-release",
  "transport-loss",
  "early-exit",
];
export const recordingModel = (provider: Provider): string | undefined =>
  env[`USINE_${provider.toUpperCase()}_INTEGRATION_MODEL`];

export const recordingPid = (savedPid: string): number => {
  const pid = Number(savedPid);
  assert(Number.isSafeInteger(pid) && pid > 0, "pid file contains a positive process ID");
  return pid;
};

const fixtureFile = (provider: Provider, scenario: Scenario) =>
  fileURLToPath(new URL(`../fixtures/replay/${scenario}/${provider}.json`, import.meta.url));
const environmentKeys = [
  "HOME",
  "PATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "USINE_GATEWAY_TOKEN",
] as const;

export const openFixture = (provider: Provider, scenario: Scenario, mode: "record" | "replay") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-replay-" });
    const file = fixtureFile(provider, scenario);
    const source =
      mode === "record"
        ? "record"
        : yield* fs.readFileString(file).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript), {
                onExcessProperty: "error",
              }),
            ),
          );
    const tape = new Tape(source);
    tape.bind(cwd, "$WORKTREE");
    const environment =
      source === "record"
        ? Object.fromEntries(
            environmentKeys.flatMap((key) => {
              const value = env[key];
              if (value === undefined) return [];
              tape.bind(value, `$${key}`);
              return [[key, value]];
            }),
          )
        : source.environment;
    if (source !== "record" && env.PATH !== undefined && environment.PATH !== undefined) {
      tape.bind(env.PATH, "$PATH");
      environment.PATH = env.PATH;
    }
    if (provider === "claude" && (scenario === "restart" || scenario === "credential-changed")) {
      environment.CLAUDE_CONFIG_DIR ??= `${environment.HOME}/.claude`;
    }
    const model = source === "record" ? recordingModel(provider) : source.model;
    assert(model !== undefined, "set the integration model to record traffic");
    const brain = BrainSpec.make({
      harness: Harness.make(provider),
      model: ModelId.make(model),
      effort: "low",
    });
    const sdk =
      mode === "record" && provider === "claude"
        ? yield* ClaudeSdk.pipe(Effect.provide(claudeSdkLive))
        : undefined;
    const descriptor = catalog.descriptors.find(({ id }) => id === provider);
    const version = descriptor?.worker.install[0]?.version;
    assert(version !== undefined);
    if (source !== "record") {
      assert.strictEqual(source.scenario, scenario);
      assert.strictEqual(
        source.protocol,
        provider === "claude" ? "claude-sdk" : "codex-app-server",
      );
      assert.strictEqual(source.harnessVersion, version);
    } else {
      const versionSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const installed = yield* versionSpawner.string(ChildProcess.make(provider, ["--version"]));
      assert.include(installed, version, "record fixtures with the pinned harness version");
    }
    const spawner = mode === "record" ? yield* ChildProcessSpawner.ChildProcessSpawner : undefined;
    const processes = processTransport(
      tape,
      spawner,
      scenario === "early-exit" && provider === "codex" ? "early-exit" : "none",
    );
    const ssh = fileURLToPath(new URL("../fixtures/replay-ssh.sh", import.meta.url));
    tape.bind(ssh, "$SSH_SHIM");
    const host =
      scenario === "transport-loss"
        ? RemoteShell.make({
            ssh: { command: ssh, args: [] },
            destination: "recorded-worker",
            sshEnvironment: { ...environment, REPLAY_DROP: `${cwd}/drop` },
          })
        : LocalProcess.make();
    const transport: Layer.Layer<ChildBackend, never, ChildProcessSpawner.ChildProcessSpawner> =
      provider === "claude"
        ? claudeChildLayer.pipe(
            Layer.provide(
              claudeTransport(tape, sdk, scenario === "early-exit" ? "early-exit" : "none"),
            ),
            Layer.provide(Layer.succeed(HostLoginLock)({ withLock: () => (effect) => effect })),
            Layer.provide(processes),
          )
        : codexChildLayer.pipe(Layer.provide(codexAppServerLive.pipe(Layer.provide(processes))));
    const backend = transport.pipe(Layer.provideMerge(NodeServices.layer));
    const request = ChildRequest.make({
      worker: WorkerName.make("replay-worker"),
      machine: Option.none(),
      host,
      environment,
      cwd: WorkingDirectory.make(cwd),
      session: ChildSession.make({
        id: AgentSessionId.make("replay-parent:child:1"),
        parentId: AgentSessionId.make("replay-parent"),
        agent: AgentName.make("replay"),
        brain,
        gatewayCredential: Option.some(GatewayCredentialKind.make("subscription")),
      }),
      prompt: "Reply with exactly REPLAY_DONE. Do not use tools.",
    });
    const drop = Effect.gen(function* () {
      tape.outbound("scenario", { method: "drop" });
      if (mode !== "record") return;
      const savedPid = yield* fs.readFileString(
        provider === "claude" ? childPidFile(cwd, request.session.id) : `${cwd}/drop.pid`,
      );
      const pid = recordingPid(savedPid);
      yield* fs.writeFileString(`${cwd}/drop`, "drop");
      process.kill(pid, "SIGKILL");
    });
    const save = Effect.gen(function* () {
      tape.assertComplete();
      if (scenario === "interrupt-guidance") {
        const traffic = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          tape.entries,
        );
        assert.include(traffic, provider === "claude" ? '"method":"interrupt"' : "turn/interrupt");
      }
      if (provider === "codex" && scenario === "transport-loss") {
        const recorded = tape.source === "record" ? tape.entries : tape.source.entries;
        assert(
          recorded.some(
            (entry) =>
              entry.type === "runtime_exit" &&
              entry.port === "process:1/exit" &&
              entry.code === 255,
          ),
          "the first SSH relay exits with a transport failure",
        );
        const ready = Schema.decodeUnknownOption(
          Schema.Struct({ ready: Schema.Literal(true), offset: Schema.Int }),
        );
        const connections = recorded.flatMap((entry) => {
          if (entry.type !== "emit_inbound") return [];
          const frame = ready(entry.payload);
          return Option.isSome(frame) ? [frame.value] : [];
        });
        assert.lengthOf(connections, 2, "transport loss reattaches the running supervisor");
        assert.strictEqual(connections[0]?.offset, 0);
        assert((connections[1]?.offset ?? 0) > 0, "reattachment resumes the saved output offset");
        const input = Schema.decodeUnknownOption(
          Schema.Struct({ sequence: Schema.Int, data: Schema.Json }),
        );
        const inputs = tape.entries.flatMap((entry) => {
          if (entry.type !== "expect_outbound" || !entry.port.endsWith("/stdin")) return [];
          const frame = input(entry.payload);
          return Option.isSome(frame) ? [{ port: entry.port, payload: frame.value }] : [];
        });
        assert.deepStrictEqual(
          inputs.filter((entry) => entry.port === "process:2/stdin").map((entry) => entry.payload),
          inputs.filter((entry) => entry.port === "process:1/stdin").map((entry) => entry.payload),
          "the replacement relay replays buffered input without starting a new thread",
        );
        const sequences = new Map<string, Set<number>>();
        for (const entry of tape.entries) {
          if (entry.type !== "expect_outbound") continue;
          const frame = Schema.decodeUnknownOption(Schema.Struct({ sequence: Schema.Int }))(
            entry.payload,
          );
          if (Option.isNone(frame)) continue;
          const seen = sequences.get(entry.port) ?? new Set<number>();
          assert(!seen.has(frame.value.sequence), "a relay sends each input sequence once");
          seen.add(frame.value.sequence);
          sequences.set(entry.port, seen);
        }
      }
      if (mode !== "record") return;
      const transcript = {
        protocol: provider === "claude" ? "claude-sdk" : "codex-app-server",
        harnessVersion: version,
        model,
        scenario,
        environment: tape.normalize(environment),
        entries: tape.entries,
      };
      const decoded = yield* Schema.decodeUnknownEffect(Transcript)(transcript);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Transcript))(decoded);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, encoded + "\n");
    });
    return { tape, cwd, backend, request, drop: drop.pipe(Effect.orDie), save };
  });
