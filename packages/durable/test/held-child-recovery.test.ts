// Durable storage and the Pi SDK use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiSdk, piChildLayer, type PiSessionEvent } from "@usine/agents/pi";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { jsonKey } from "@usine/core/json-key";
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { AttemptRecordDoc, HoldDoc } from "../src/attempt/documents.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import { answer, delegate, fauxParent, type ParentStep } from "../src/testing.ts";
import { assertAdmitted, attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

for (const supervision of [
  "held",
  "held-unread",
  "paused",
  "held-paused",
  "held-idle",
  "held-idle-steer",
] as const) {
  const paused = supervision === "paused" || supervision === "held-paused";
  const held = supervision !== "paused";
  const heldIdle = supervision === "held-idle" || supervision === "held-idle-steer";
  it.live(`restores a ${supervision} child before starting another turn`, () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const initial = attemptRequest(`recovery/${supervision}-child`, 1);
      const request = AttemptRequest.make({
        ...initial,
        spec: {
          ...initial.spec,
          agent: Agent.make({
            ...initial.spec.agent,
            brain: BrainSpec.make({
              harness: Harness.make("pi"),
              model: ModelId.make("openai/model"),
              effort: "medium",
            }),
          }),
        },
      });
      const saved = HarnessSession.make({
        id: HarnessSessionId.make("held-child"),
        cwd: request.cwd,
      });
      const recording = recordingSink();
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      let firstSession = Option.none<AgentSessionId>();
      let unreadId = Option.none<AttemptChannel.OperatorMessageId>();

      for (const resumed of [false, true]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const turn = yield* Deferred.make<void>();
            const prompted = yield* Deferred.make<void>();
            const prompts: string[] = [];
            const metered = yield* Deferred.make<void>();
            const listeners = new Set<(event: PiSessionEvent) => void>();
            const started = yield* Deferred.make<AgentSessionId>();
            const idle = yield* Deferred.make<void>();
            const sdk = Layer.succeed(PiSdk)({
              start: async (options) => {
                assert.strictEqual(options.storage._tag, resumed ? "Resume" : "Create");
                if (options.storage._tag === "Resume")
                  assert.strictEqual(options.storage.id, saved.id);
                return {
                  _tag: "Started",
                  model: options.model,
                  pool: "apiKeys",
                  tools: ["read", "bash", "edit", "write"],
                  harnessSession: Option.some(saved),
                  session: {
                    messages: [
                      answer(resumed ? "The corrected child report." : "The child's final report."),
                    ],
                    subscribe: (callback) => {
                      listeners.add(callback);
                      return () => {
                        listeners.delete(callback);
                      };
                    },
                    prompt: (message) => {
                      prompts.push(message);
                      for (const listener of listeners)
                        listener({
                          type: "message_end",
                          message: {
                            ...answer("Usage checkpoint"),
                            content: [],
                            usage: {
                              input: resumed ? 400 : 800,
                              output: resumed ? 100 : 200,
                              cacheRead: 0,
                              cacheWrite: 0,
                              totalTokens: resumed ? 500 : 1000,
                              cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: resumed ? 0.125 : 0.25,
                              },
                            },
                          },
                        });
                      return run(
                        Deferred.succeed(prompted, undefined).pipe(
                          Effect.andThen(Deferred.await(turn)),
                        ),
                      );
                    },
                    steer: async () =>
                      supervision === "held-unread" && !resumed ? "queued" : "handled",
                    abort: () => run(Deferred.succeed(turn, undefined).pipe(Effect.asVoid)),
                    dispose: () => {},
                  },
                };
              },
            });
            const parent: ReadonlyArray<ParentStep> = resumed
              ? [answer("Finished after release.")]
              : [delegate("Continue the task")];
            const services = yield* Layer.build(
              runtimeLayer.pipe(
                Layer.provideMerge(
                  harnessLayer({
                    ...fauxParent(parent),
                    openStorage: Effect.tryPromise({
                      try: () => openNodeSqliteStorage(database),
                      catch: (cause) => durableError("open recovery storage", cause),
                    }),
                  }),
                ),
                Layer.provide(piChildLayer.pipe(Layer.provide(sdk))),
              ),
            );
            const runtime = Context.get(services, AttemptRuntime);
            const execution = yield* Effect.forkChild(
              runtime.execute(request, {
                ...recording.sink,
                append: (direction, envelope) =>
                  recording.sink.append(direction, envelope).pipe(
                    Effect.andThen(() => {
                      if (
                        envelope._tag !== "OutboundEnvelope" ||
                        envelope.payload._tag !== "SessionEvent"
                      )
                        return Effect.void;
                      const event = envelope.payload.event;
                      if (event.session._tag !== "ChildSession") return Effect.void;
                      if (event._tag === "SessionStarted")
                        return Deferred.succeed(started, event.session.id).pipe(Effect.asVoid);
                      if (event._tag === "SessionTokensUpdated")
                        return Deferred.succeed(metered, undefined).pipe(Effect.asVoid);
                      if (event._tag === "SessionIdle")
                        return Deferred.succeed(idle, undefined).pipe(Effect.asVoid);
                      return Effect.void;
                    }),
                  ),
              }),
            );
            const sessionId = yield* Deferred.await(started);
            const operator = (action: AttemptChannel.OperatorAction) =>
              runtime.intervene(
                request.spec.attemptId,
                AttemptChannel.Intervention.make({
                  operator: "PhilDL",
                  target: AttemptChannel.ChildTarget.make({ sessionId }),
                  action,
                }),
              );
            if (!resumed) {
              firstSession = Option.some(sessionId);
              yield* Deferred.await(prompted);
              yield* Deferred.await(metered);
              if (held) {
                const guidance = AttemptChannel.OperatorMessage.make({
                  message: "Wait for my release.",
                });
                unreadId = Option.some(guidance.id);
                yield* operator(guidance);
              }
              if (paused || heldIdle) {
                if (paused) yield* operator(AttemptChannel.Interrupt.make());
                yield* Deferred.succeed(turn, undefined);
                yield* Deferred.await(idle);
              }
              yield* Fiber.interrupt(execution);
              return;
            }
            assert.deepStrictEqual(Option.some(sessionId), firstSession);
            if (heldIdle) {
              yield* Effect.raceFirst(Deferred.await(idle), Deferred.await(prompted));
              assert.deepStrictEqual(prompts, [], "A held idle child must not start another turn");
              assert.isUndefined(execution.pollUnsafe());
              if (supervision === "held-idle-steer") {
                yield* operator(
                  AttemptChannel.Steer.make({ message: "Continue with my correction." }),
                );
                yield* Deferred.await(prompted);
                assert.deepStrictEqual(prompts, ["Continue with my correction."]);
              }
            } else if (paused) {
              yield* Effect.raceFirst(Deferred.await(idle), Deferred.await(prompted));
              assert.deepStrictEqual(
                prompts,
                [],
                "A paused child must wait for guidance after restart",
              );
              const state = yield* Context.get(services, DurableHarness).use(
                "read restored child pause",
                async (harness, context) => {
                  const record = await harness.snapshot(
                    AttemptRecordDoc,
                    request.spec.attemptId,
                    context,
                  );
                  assert(record?.taskId !== null && record?.taskId !== undefined);
                  return harness.snapshot(HoldDoc, record.taskId, context);
                },
              );
              assert.deepStrictEqual(state?.pausedChildren, [sessionId]);
              yield* operator(AttemptChannel.Release.make());
              assert.deepStrictEqual(prompts, [], "Releasing a Hold must preserve the pause");
              yield* operator(
                AttemptChannel.Steer.make({ message: "Continue with my correction." }),
              );
              yield* Deferred.await(prompted);
              assert.deepStrictEqual(prompts, ["Continue with my correction."]);
            } else {
              yield* Deferred.await(idle);
              assert.deepStrictEqual(
                prompts,
                [],
                "A held child must wait for guidance after restart",
              );
              yield* operator(
                AttemptChannel.Steer.make({ message: "Continue with my correction." }),
              );
              yield* Deferred.await(prompted);
              assert.deepStrictEqual(
                prompts,
                [
                  supervision === "held-unread"
                    ? "Wait for my release."
                    : "Continue with my correction.",
                ],
                "unread input precedes the new guidance",
              );
            }
            yield* Deferred.succeed(turn, undefined);
            if (held && !paused) {
              yield* Deferred.await(idle);
              assert.isUndefined(execution.pollUnsafe());
              yield* operator(AttemptChannel.Release.make());
            }
            assert.strictEqual((yield* Fiber.join(execution)).message, "Finished after release.");
            const state = yield* Context.get(services, DurableHarness).use(
              "read released supervision and child budget",
              async (harness, context) => {
                const record = await harness.snapshot(
                  AttemptRecordDoc,
                  request.spec.attemptId,
                  context,
                );
                const hold =
                  record?.taskId === null || record?.taskId === undefined
                    ? undefined
                    : await harness.snapshot(HoldDoc, record.taskId, context);
                return {
                  children: record?.children,
                  held: hold?.held ?? [],
                  paused: hold?.pausedChildren ?? [],
                };
              },
            );
            assert.deepStrictEqual(state, { children: 1, held: [], paused: [] });
          }),
        );
      }
      const outbound = recording.outbound();
      if (supervision === "held-unread") {
        assert(Option.isSome(unreadId));
        const id = unreadId.value;
        const deliveries = outbound.flatMap(({ payload }) =>
          payload._tag === "InterventionApplied" &&
          payload.intervention.action._tag === "OperatorMessage" &&
          payload.intervention.action.id === id
            ? [payload.state.queued]
            : [],
        );
        assert.deepStrictEqual(
          deliveries,
          [true, false],
          "the restored ID settles the original queued input",
        );
      }
      const usage = outbound.flatMap(({ payload }) =>
        payload._tag === "SessionEvent" &&
        payload.event._tag === "SessionTokensUpdated" &&
        payload.event.session._tag === "ChildSession"
          ? [payload.event]
          : [],
      );
      assert.deepStrictEqual(
        usage.map(({ totalTokens }) => totalTokens),
        supervision === "held-idle" ? [1000] : [1000, 1500],
      );
      assert.deepStrictEqual(
        usage.at(-1)?.costUsd,
        Option.some(supervision === "held-idle" ? 0.25 : 0.375),
      );
      assert(!outbound.some(({ payload }) => payload._tag === "InterventionRejected"));
      const finished = outbound.flatMap(({ payload }) =>
        payload._tag === "SessionEvent" && payload.event._tag === "ToolFinished"
          ? [payload.event]
          : [],
      );
      assert.lengthOf(finished, 1);
      assert.include(
        jsonKey(finished[0]?.output),
        supervision === "held-idle" ? "The child's final report." : "The corrected child report.",
      );
      assertAdmitted(request.spec.attemptId, outbound);
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );
}
