import { assert } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { Deferred, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { LocalProcess, RemoteShell } from "../../src/child-host/child-host.ts";
import { claudeChildLayer } from "../../src/harness/claude/claude.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { ClaudeSdk, claudeSdkLive } from "../../src/harness/claude/sdk.ts";
import { codexChildLayer } from "../../src/harness/codex/codex.ts";
import { codexAppServerLive } from "../../src/harness/codex/app-server.ts";
import { ChildBackend, ChildRequest, HostLoginLock, WorkingDirectory } from "../../src/runtime.ts";
import { ownedClaudeReplay } from "./owned-claude.ts";
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

export interface FixtureOptions {
  /** Rewrites the decoded transcript before the replay tape reads it. Ignored when recording. */
  readonly transform?: (transcript: Transcript) => Transcript;
}

export const openFixture = (
  provider: Provider,
  scenario: Scenario,
  mode: "record" | "replay",
  options: FixtureOptions = {},
) =>
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
            Effect.map((transcript) => options.transform?.(transcript) ?? transcript),
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
    const boundary = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const transport: Layer.Layer<ChildBackend, never, ChildProcessSpawner.ChildProcessSpawner> =
      provider === "claude"
        ? claudeChildLayer.pipe(
            Layer.provide(
              claudeTransport(
                tape,
                sdk,
                scenario === "early-exit" ? "early-exit" : "none",
                scenario === "interrupt-guidance" ? { boundary, started, released } : undefined,
              ),
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
    if (mode === "replay" && provider === "codex" && scenario === "early-exit") {
      yield* fs.writeFileString(
        `${cwd}/codex`,
        "#!/usr/bin/env node\nprocess.stderr.write('replayed early exit'); process.exitCode = 7;\n",
      );
      yield* fs.chmod(`${cwd}/codex`, 0o755);
      return {
        tape: new Tape("record"),
        cwd,
        request: ChildRequest.make({
          ...request,
          environment: { ...environment, PATH: `${cwd}:${environment.PATH}` },
        }),
        backend: codexChildLayer.pipe(
          Layer.provide(codexAppServerLive),
          Layer.provide(NodeServices.layer),
        ),
        save: Effect.void,
        controls: {
          nativeReceipts: true,
          drop: Effect.void,
          boundary: Effect.void,
          toolReady: Effect.void,
          releaseCommand: Effect.void,
          sessionReleased: Effect.void,
        },
      };
    }
    if (
      mode === "replay" &&
      provider === "claude" &&
      (scenario === "transport-loss" || scenario === "early-exit")
    ) {
      assert(source !== "record");
      const owned = yield* ownedClaudeReplay(request, source, scenario);
      const idleTape = new Tape("record");
      return {
        ...owned,
        tape: idleTape,
        cwd,
        controls: {
          nativeReceipts: false,
          drop: Effect.gen(function* () {
            const savedPid = yield* fs.readFileString(`${cwd}/drop.pid`);
            yield* fs.writeFileString(`${cwd}/drop`, "drop");
            process.kill(recordingPid(savedPid), "SIGKILL");
          }).pipe(Effect.orDie),
          releaseCommand: fs.writeFileString(`${cwd}/release`, "ready").pipe(Effect.orDie),
          sessionReleased: Effect.void,
          boundary: Effect.void,
          toolReady: Effect.void,
        },
      };
    }
    const drop = Effect.gen(function* () {
      tape.outbound("scenario", { method: "drop" });
      if (mode !== "record") return;
      const savedPid = yield* fs.readFileString(`${cwd}/drop.pid`);
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
      if (provider === "codex" && scenario === "interrupt-guidance") {
        const recorded = tape.source === "record" ? tape.entries : tape.source.entries;
        const method = (name: string) => Schema.is(Schema.Struct({ method: Schema.Literal(name) }));
        const interrupt = recorded.findIndex(
          (entry) =>
            entry.type === "expect_outbound" &&
            entry.port === "process:1/stdin" &&
            method("turn/interrupt")(entry.payload),
        );
        const completed = recorded.findIndex(
          (entry) =>
            entry.type === "emit_inbound" &&
            entry.port === "process:1/stdout" &&
            Schema.is(
              Schema.Struct({
                method: Schema.Literal("turn/completed"),
                params: Schema.Struct({
                  turn: Schema.Struct({ status: Schema.Literal("interrupted") }),
                }),
              }),
            )(entry.payload),
        );
        const guided = recorded.findIndex(
          (entry, index) =>
            index > completed &&
            entry.type === "expect_outbound" &&
            entry.port === "process:1/stdin" &&
            method("turn/start")(entry.payload),
        );
        assert(
          interrupt >= 0 && completed > interrupt && guided > completed,
          "interrupt completes before guidance starts a new turn",
        );
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
    return {
      tape,
      cwd,
      backend,
      request,
      controls: {
        nativeReceipts: true,
        drop: drop.pipe(Effect.orDie),
        // Release must precede this connection's clean exit, independently of later launches.
        sessionReleased:
          provider === "claude" && scenario === "interrupt-guidance"
            ? Effect.sync(() => tape.outbound("claude:1/scenario", { method: "release" }))
            : Effect.void,
        releaseCommand: Effect.gen(function* () {
          // A recorded completion cannot overtake the operator's command release.
          if (scenario === "interrupt-guidance")
            tape.outbound(`${provider === "claude" ? "claude" : "process"}:1/scenario`, {
              method: "release-command",
            });
          yield* fs.writeFileString(`${cwd}/release`, "ready");
          yield* Deferred.succeed(released, undefined);
        }).pipe(Effect.asVoid, Effect.orDie),
        boundary: Deferred.await(boundary).pipe(Effect.timeout("30 seconds"), Effect.orDie),
        toolReady: Effect.gen(function* () {
          if (scenario !== "interrupt-guidance") return;
          if (provider === "claude") yield* Deferred.await(started);
          if (mode === "record") {
            while (!(yield* fs.exists(`${cwd}/started`))) yield* Effect.sleep("10 millis");
          }
        }).pipe(Effect.timeout("30 seconds"), Effect.orDie),
      },
      save,
    };
  });
