// Durable storage opens through the native SQLite Promise API.
// @effect-diagnostics asyncFunction:off
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Agent, AgentPersona } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { RunSpec } from "@usine/core/attempt/channel";
import { GatewayCredentialKind } from "@usine/core/worker";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { openFixture, providers, recordingModel } from "../../agents/test/replay/fixture.ts";
import { waitingPrompt, waitScript } from "../../agents/test/replay/scenarios.ts";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { durableError, layer as harnessLayer } from "../src/harness.ts";
import { answer, delegate, fauxParent, type ParentStep } from "../src/testing.ts";
import { attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

export const restartReplays = (mode: "record" | "replay"): void => {
  for (const provider of providers)
    for (const scenario of ["restart", "credential-changed"] as const) {
      it.live.skipIf(mode === "record" && recordingModel(provider) === undefined)(
        `${mode} ${provider}: ${scenario}`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const fixture = yield* openFixture(provider, scenario, mode);
              const fs = yield* FileSystem.FileSystem;
              const database = yield* temporaryDatabase;
              yield* fs.writeFileString(`${fixture.cwd}/wait.cjs`, waitScript);
              const original = attemptRequest(`replay/${provider}/${scenario}`, 1);
              const request = AttemptRequest.make({
                ...original,
                cwd: fixture.cwd,
                environment: fixture.request.environment,
                worker: fixture.request.worker,
                spec: RunSpec.make({
                  ...original.spec,
                  task: AttemptTask.make(waitingPrompt),
                  agent: Agent.make({
                    ...original.spec.agent,
                    brain: fixture.request.session.brain,
                    persona: AgentPersona.make("Follow the task exactly."),
                  }),
                }),
                gatewayCredential: Effect.succeedSome(GatewayCredentialKind.make("subscription")),
              });
              const runtime = (parent: ReadonlyArray<ParentStep>) =>
                runtimeLayer.pipe(
                  Layer.provide(
                    harnessLayer({
                      ...fauxParent(parent),
                      openStorage: Effect.tryPromise({
                        try: () => openNodeSqliteStorage(database),
                        catch: (cause) => durableError("open replay SQLite", cause),
                      }),
                    }),
                  ),
                  Layer.provide(fixture.backend),
                );
              const recorded = recordingSink();
              const checkpoint = yield* Deferred.make<void>();
              const sink = {
                ...recorded.sink,
                append: (
                  direction: Parameters<typeof recorded.sink.append>[0],
                  envelope: Parameters<typeof recorded.sink.append>[1],
                ) =>
                  recorded.sink
                    .append(direction, envelope)
                    .pipe(
                      Effect.andThen(
                        envelope._tag === "OutboundEnvelope" &&
                          envelope.payload._tag === "SessionEvent" &&
                          envelope.payload.event._tag === "ToolStarted" &&
                          envelope.payload.event.session._tag === "ChildSession"
                          ? Deferred.succeed(checkpoint, undefined).pipe(Effect.asVoid)
                          : Effect.void,
                      ),
                    ),
              };
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const services = yield* Layer.build(runtime([delegate(waitingPrompt)]));
                  const execution = yield* Context.get(services, AttemptRuntime)
                    .execute(request, sink)
                    .pipe(Effect.forkChild);
                  yield* Deferred.await(checkpoint);
                  yield* Fiber.interrupt(execution);
                }).pipe(fixture.tape.guard),
              );
              yield* fs.writeFileString(`${fixture.cwd}/release`, "ready");
              const homeVariable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
              const tokenVariable = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
              const gatewayToken = request.environment.USINE_GATEWAY_TOKEN;
              const changedEnvironment = { ...request.environment };
              if (scenario === "credential-changed") {
                assert(
                  gatewayToken !== undefined,
                  "credential-change recordings require a gateway caller token",
                );
                changedEnvironment[tokenVariable] = gatewayToken;
              }
              const resumed =
                scenario === "credential-changed"
                  ? AttemptRequest.make({
                      ...request,
                      environment: changedEnvironment,
                      gatewayCredential: Effect.succeedSome(GatewayCredentialKind.make("api-key")),
                    })
                  : AttemptRequest.make({ ...request, environment: changedEnvironment });
              const report = yield* Effect.scoped(
                Effect.gen(function* () {
                  const services = yield* Layer.build(runtime([answer("REPLAY_PARENT_DONE")]));
                  return yield* Context.get(services, AttemptRuntime)
                    .execute(resumed, recorded.sink)
                    .pipe(fixture.tape.guard);
                }),
              );
              assert.strictEqual(report.message, "REPLAY_PARENT_DONE");
              const events = recorded
                .outbound()
                .flatMap(({ payload }) => (payload._tag === "SessionEvent" ? [payload.event] : []));
              const starts = events.flatMap((event) =>
                event._tag === "SessionStarted" && event.session._tag === "ChildSession"
                  ? [event]
                  : [],
              );
              const interrupted = events.filter(
                (event) =>
                  event._tag === "ToolFinished" &&
                  event.session._tag === "ChildSession" &&
                  event.isError,
              );
              assert.lengthOf(
                interrupted,
                1,
                "restart closes the child's interrupted native tool call",
              );
              assert.lengthOf(starts, 2);
              assert.strictEqual(starts[0]?.session.id, starts[1]?.session.id);
              assert.deepStrictEqual(starts[0]?.harnessSession, starts[1]?.harnessSession);
              const saved = starts[0]?.harnessSession;
              assert(
                saved !== undefined && Option.isSome(saved) && Option.isSome(saved.value.home),
              );
              const savedHome = saved.value.home.value;
              const environmentSchema = Schema.Record(Schema.String, Schema.String);
              const launchSchema = Schema.decodeUnknownOption(
                Schema.Union([
                  Schema.Struct({
                    method: Schema.Literal("open"),
                    options: Schema.Struct({ env: environmentSchema }),
                  }),
                  Schema.Struct({ env: environmentSchema }),
                ]),
              );
              const environments = fixture.tape.entries.flatMap((entry) => {
                if (entry.type !== "expect_outbound") return [];
                const launch = launchSchema(entry.payload);
                if (Option.isNone(launch)) return [];
                return ["options" in launch.value ? launch.value.options.env : launch.value.env];
              });
              assert.lengthOf(environments, 2);
              assert.strictEqual(
                environments[1]?.[homeVariable],
                fixture.tape.normalize(savedHome),
              );
              if (scenario === "credential-changed") {
                assert.strictEqual(environments[0]?.[tokenVariable], undefined);
                assert.strictEqual(
                  environments[1]?.[tokenVariable],
                  fixture.tape.normalize(changedEnvironment[tokenVariable] ?? ""),
                );
              }
              const child = starts[1]?.session;
              assert(child !== undefined);
              assert.deepStrictEqual(
                child.pool,
                Option.some(
                  scenario === "credential-changed"
                    ? "apiKeys"
                    : provider === "claude"
                      ? "claudePlan"
                      : "chatgptPlan",
                ),
              );
              assert(
                events.some(
                  (event) =>
                    event._tag === "TextOutput" &&
                    event.session._tag === "ChildSession" &&
                    event.text.includes("REPLAY_DONE"),
                ),
              );
              assert(
                events.some(
                  (event) =>
                    event._tag === "ToolFinished" &&
                    event.session._tag === "ParentSession" &&
                    !event.isError,
                ),
              );
              yield* fixture.save;
            }),
          ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("180 seconds")),
        240_000,
      );
    }
};
