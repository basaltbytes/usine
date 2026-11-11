// The durable model and storage adapters use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { childDispatcherLayer } from "@usine/agents/children";
import { harnessesLive } from "@usine/agents/harness/node";
import { HostLoginLock } from "@usine/agents/runtime";
import { Agent, AgentPersona } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { jsonKey } from "@usine/core/json-key";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { LocalProcess, RemoteShell } from "@usine/agents/child-host";
import {
  Config,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { AttemptRequest, AttemptRuntime } from "../../src/attempt-runtime.ts";
import { durableError, layer as harnessLayer } from "../../src/harness.ts";
import {
  answer,
  delegate,
  fauxParent,
  type ParentStep,
  routedRuntimeLayer as runtimeLayer,
} from "../../src/testing.ts";
import { attemptRequest, recordingSink } from "../support.ts";

for (const harness of ["claude", "codex", "pi"] as const) {
  for (const placement of harness === "pi" ? ["local"] : ["local", "ssh"]) {
    it.live(
      `resumes a live ${harness} child after an orchestrator restart (${placement})`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped();
          const database = path.join(directory, "durable.sqlite");
          const model = yield* Config.String(
            `USINE_${harness.toUpperCase()}_INTEGRATION_MODEL`,
          ).pipe(Effect.flatMap(Schema.decodeEffect(ModelId)));
          const gatewayCredential = yield* Config.Literals(
            ["api-key", "subscription"],
            `USINE_${harness.toUpperCase()}_INTEGRATION_GATEWAY_CREDENTIAL`,
          ).pipe(Config.option);
          const original = attemptRequest(`live-restart/${harness}`, 1);
          const request = AttemptRequest.make({
            ...original,
            cwd: directory,
            gatewayCredential: Effect.succeed(gatewayCredential),
            host:
              placement === "local"
                ? LocalProcess.make()
                : RemoteShell.make({
                    ssh: {
                      command: fileURLToPath(
                        new URL("../../../agents/test/fixtures/ssh-shim.sh", import.meta.url),
                      ),
                      args: [],
                    },
                    sshEnvironment: Object.fromEntries(
                      Object.entries(env).filter(
                        (entry): entry is [string, string] => entry[1] !== undefined,
                      ),
                    ),
                    destination: "worker.example",
                  }),
            environment: Object.fromEntries(
              Object.entries(env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          });
          const task = AttemptTask.make(
            `Remember the code word cobalt-otter. Run a shell command that creates command.started, then waits up to 120 seconds until a file named release exists in this directory. After the wait, reply with exactly cobalt-otter. After an orchestrator restart, repeat the wait if needed, then return the same code word.`,
          );
          const liveRequest = AttemptRequest.make({
            ...request,
            spec: {
              ...request.spec,
              task,
              agent: Agent.make({
                ...request.spec.agent,
                persona: AgentPersona.make(
                  "Complete the delegated task. Do not call GitHub or edit repository files.",
                ),
                brain: BrainSpec.make({ harness: Harness.make(harness), model, effort: "low" }),
              }),
            },
          });
          const backend = childDispatcherLayer.pipe(
            Layer.provide(harnessesLive),
            Layer.provide(Layer.succeed(HostLoginLock)({ withLock: () => (effect) => effect })),
          );
          const attempts = (parent: ReadonlyArray<ParentStep>) =>
            runtimeLayer.pipe(
              Layer.provideMerge(
                harnessLayer({
                  ...fauxParent(parent),
                  openStorage: Effect.tryPromise({
                    try: () => openNodeSqliteStorage(database),
                    catch: (cause) => durableError("open live restart storage", cause),
                  }),
                }),
              ),
              Layer.provide(backend),
            );
          const recording = recordingSink();
          const saved = yield* Deferred.make<void>();
          const sink = {
            ...recording.sink,
            append: (
              direction: Parameters<typeof recording.sink.append>[0],
              envelope: Parameters<typeof recording.sink.append>[1],
            ) =>
              recording.sink
                .append(direction, envelope)
                .pipe(
                  Effect.andThen(
                    envelope._tag === "OutboundEnvelope" &&
                      envelope.payload._tag === "SessionEvent" &&
                      envelope.payload.event._tag === "SessionStarted" &&
                      Option.isSome(envelope.payload.event.harnessSession)
                      ? Deferred.succeed(saved, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(attempts([delegate("Complete the task.")]));
              const execution = yield* Effect.forkChild(
                Context.get(services, AttemptRuntime).execute(liveRequest, sink),
              );
              yield* Effect.raceFirst(
                Deferred.await(saved).pipe(
                  Effect.andThen(
                    fileSystem.exists(path.join(directory, "command.started")).pipe(
                      Effect.repeat({
                        while: (exists) => !exists,
                        schedule: Schedule.spaced("100 millis"),
                      }),
                    ),
                  ),
                  Effect.timeout("90 seconds"),
                ),
                Fiber.join(execution).pipe(
                  Effect.flatMap((report) =>
                    Effect.die(
                      new Error(
                        `Attempt ended before the child command started: ${report.message}`,
                      ),
                    ),
                  ),
                ),
              );
              yield* Fiber.interrupt(execution);
            }),
          );
          yield* fileSystem.writeFileString(path.join(directory, "release"), "ready");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const services = yield* Layer.build(attempts([answer("cobalt-otter")]));
              const report = yield* Context.get(services, AttemptRuntime)
                .execute(liveRequest, sink)
                .pipe(Effect.timeout("120 seconds"));
              assert.strictEqual(report.message, "cobalt-otter");
            }),
          );
          const reports = recording
            .outbound()
            .flatMap(({ payload }) =>
              payload._tag === "SessionEvent" &&
              payload.event._tag === "ToolFinished" &&
              payload.event.session._tag === "ParentSession"
                ? [payload.event]
                : [],
            );
          assert.lengthOf(reports, 1);
          assert.isFalse(reports[0]?.isError);
          assert.include(jsonKey(reports[0]?.output), "cobalt-otter");
          const sessions = recording
            .outbound()
            .flatMap(({ payload }) =>
              payload._tag === "SessionEvent" &&
              payload.event._tag === "SessionStarted" &&
              payload.event.session._tag === "ChildSession" &&
              Option.isSome(payload.event.harnessSession)
                ? [payload.event]
                : [],
            );
          assert.lengthOf(sessions, 2);
          assert.strictEqual(sessions[0]?.session.id, sessions[1]?.session.id);
          assert.deepStrictEqual(sessions[0]?.harnessSession, sessions[1]?.harnessSession);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      300_000,
    );
  }
}
