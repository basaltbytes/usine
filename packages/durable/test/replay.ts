// Durable storage opens through the native SQLite Promise API.
// @effect-diagnostics asyncFunction:off
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Agent, AgentPersona, type ParentKind } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { RunSpec } from "@usine/core/attempt/channel";
import { GatewayCredentialKind } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { openFixture, providers, recordingModel } from "../../agents/test/replay/fixture.ts";
import { waitingPrompt, waitScript } from "../../agents/test/replay/scenarios.ts";
import { isJsonObject, type Transcript } from "../../agents/test/replay/transcript.ts";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { FIRST_ASSIGNMENT } from "../src/attempt/coordinator/rules.ts";
import { layer as attemptRuntimeLayer } from "../src/attempt/runtime.ts";
import { routerLayer } from "../src/coordinator/router.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import { durableError, layer as harnessLayer } from "../src/harness.ts";
import { answer, delegate, fauxParent, type ParentStep } from "../src/testing.ts";
import { attemptRequest, recordingSink, sqliteJournal, temporaryDatabase } from "./support.ts";

const replaceText = (value: Schema.Json, from: string, to: string): Schema.Json => {
  if (Predicate.isString(value)) return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((item) => replaceText(item, from, to));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceText(item, from, to)]),
  );
};

/**
 * Rewrites a transcript recorded through the Pi parent for the coordinator. The Pi parent
 * delegated the task as the child's supplemental context; the coordinator sends its first
 * assignment there, and the rest of the traffic is the same.
 */
const coordinatorTranscript = (transcript: Transcript): Transcript => {
  const recorded = `${waitingPrompt}\n\n# Delegated task`;
  const coordinated = `${FIRST_ASSIGNMENT}\n\n# Delegated task`;
  const entries = transcript.entries.map((entry) =>
    entry.type === "runtime_exit"
      ? entry
      : { ...entry, payload: replaceText(entry.payload, recorded, coordinated) },
  );
  assert.notDeepEqual(entries, transcript.entries, "the transcript sends the delegated task");
  return { ...transcript, entries };
};

/**
 * Provides `AttemptRuntime` as production routes it, over pi-durable on `storage` and the attempt
 * journal on `journal`, with the Pi parent's answers `parent`. Each layer built is one
 * orchestrator process.
 */
const routedRuntime = (storage: string, journal: string, parent: ReadonlyArray<ParentStep>) =>
  routerLayer.pipe(
    Layer.provide(Layer.mergeAll(attemptRuntimeLayer, CoordinatorRuntime.layer)),
    Layer.provide(WakeUp.rules),
    Layer.provide(sqliteJournal(journal)),
    Layer.provide(
      harnessLayer({
        ...fauxParent(parent),
        openStorage: Effect.tryPromise({
          try: () => openNodeSqliteStorage(storage),
          catch: (cause) => durableError("open replay SQLite", cause),
        }),
      }),
    ),
  );

/**
 * Registers the recorded restart and credential-change scenarios for each harness. A replay runs
 * each one through the Pi parent and through the event-driven coordinator; a recording runs the
 * Pi parent, whose transcript both replays read.
 */
export const restartReplays = (mode: "record" | "replay"): void => {
  const parents: ReadonlyArray<ParentKind> = mode === "record" ? ["pi"] : ["pi", "none"];
  for (const provider of providers)
    for (const scenario of ["restart", "credential-changed"] as const)
      for (const parent of parents) {
        const coordinated = parent === "none";
        it.live.skipIf(mode === "record" && recordingModel(provider) === undefined)(
          `${mode} ${provider}: ${scenario} through the ${coordinated ? "coordinator" : "Pi parent"}`,
          () =>
            Effect.scoped(
              Effect.gen(function* () {
                const fixture = yield* openFixture(
                  provider,
                  scenario,
                  mode,
                  coordinated ? { transform: coordinatorTranscript } : {},
                );
                const fs = yield* FileSystem.FileSystem;
                const storage = yield* temporaryDatabase;
                const journal = yield* temporaryDatabase;
                yield* fs.writeFileString(`${fixture.cwd}/wait.cjs`, waitScript);
                const original = attemptRequest(`replay/${provider}/${scenario}`, 1);
                const request = AttemptRequest.make({
                  ...original,
                  cwd: fixture.cwd,
                  environment: fixture.request.environment,
                  worker: fixture.request.worker,
                  spec: RunSpec.make({
                    ...original.spec,
                    parent,
                    parentModel: coordinated ? Option.none() : original.spec.parentModel,
                    task: AttemptTask.make(waitingPrompt),
                    agent: Agent.make({
                      ...original.spec.agent,
                      brain: fixture.request.session.brain,
                      persona: AgentPersona.make("Follow the task exactly."),
                    }),
                  }),
                  gatewayCredential: Effect.succeedSome(GatewayCredentialKind.make("subscription")),
                });
                // The coordinator calls no parent model, so its replays script no answers.
                const runtime = (steps: ReadonlyArray<ParentStep>) =>
                  routedRuntime(storage, journal, coordinated ? [] : steps).pipe(
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
                const tokenVariable =
                  provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
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
                        gatewayCredential: Effect.succeedSome(
                          GatewayCredentialKind.make("api-key"),
                        ),
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
                // The coordinator reports the child's final answer.
                assert.strictEqual(
                  report.message,
                  coordinated ? "REPLAY_DONE" : "REPLAY_PARENT_DONE",
                );
                const outbound = recorded.outbound();
                const terminal = outbound.filter(({ payload }) =>
                  ["Final", "Failed", "Interrupted"].includes(payload._tag),
                );
                assert.deepStrictEqual(
                  terminal.map(({ payload }) => payload._tag),
                  ["Final"],
                  "the Attempt ends with one terminal outcome",
                );
                const events = outbound.flatMap(({ payload }) =>
                  payload._tag === "SessionEvent" ? [payload.event] : [],
                );
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
                assert.deepStrictEqual(
                  starts[0]?.session.pool,
                  Option.some(provider === "claude" ? "claudePlan" : "chatgptPlan"),
                );
                const resumedStart = starts[1];
                assert(resumedStart !== undefined);
                const child = resumedStart.session;
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
                if (scenario === "credential-changed") {
                  const resumedEvents = events
                    .slice(events.indexOf(resumedStart))
                    .filter((event) => event.session._tag === "ChildSession");
                  const usage = resumedEvents.filter(
                    (event) => event._tag === "SessionTokensUpdated",
                  );
                  assert.isNotEmpty(usage);
                  for (const event of usage)
                    assert.deepStrictEqual(event.session.pool, Option.some("apiKeys"));
                  if (provider === "codex") {
                    const limits = resumedEvents.filter(
                      (event) => event._tag === "PoolRateLimitsUpdated",
                    );
                    assert.isNotEmpty(limits);
                    for (const event of limits) {
                      assert.strictEqual(event.pool, "apiKeys");
                      assert.deepStrictEqual(event.login, Option.none());
                    }
                  }
                }
                assert(
                  events.some(
                    (event) =>
                      event._tag === "TextOutput" &&
                      event.session._tag === "ChildSession" &&
                      event.text.includes("REPLAY_DONE"),
                  ),
                );
                if (coordinated)
                  assert(
                    events.every((event) => event.session._tag === "ChildSession"),
                    "the coordinator runs no parent session",
                  );
                else
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
