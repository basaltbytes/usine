// Durable storage and the Pi SDK use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CONTINUATION_MESSAGE } from "@usine/agents/continuation";
import { PiSdk, piChildLayer } from "@usine/agents/pi";
import { ChildBackend } from "@usine/agents/runtime";
import { Agent } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { HarnessSession, HarnessSessionId } from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue } from "effect";
import { AttemptRequest, AttemptRuntime } from "../src/attempt-runtime.ts";
import { AttemptRecordDoc } from "../src/attempt/documents.ts";
import { routedRuntimeLayer as runtimeLayer } from "../src/testing.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import { answer, delegate, fauxParent } from "../src/testing.ts";
import { assertAdmitted, attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

it.live("refuses a fourth continuation after three durable restarts within ten minutes", () =>
  Effect.gen(function* () {
    const database = yield* temporaryDatabase;
    const initial = attemptRequest("recovery/continuation-limit", 1);
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
      id: HarnessSessionId.make("working-child"),
      cwd: request.cwd,
    });
    const recording = recordingSink();
    const prompts: string[] = [];
    const histories: number[][] = [];
    const sessions: string[] = [];
    const errors: string[] = [];
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    for (let restart = 0; restart <= 4; restart += 1) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const prompted = yield* Queue.make<void>();
          const turn = yield* Deferred.make<void>();
          const sdk = Layer.succeed(PiSdk)({
            start: async (options) => {
              assert.strictEqual(options.storage._tag, restart === 0 ? "Create" : "Resume");
              if (options.storage._tag === "Resume")
                assert.strictEqual(options.storage.id, saved.id);
              return {
                _tag: "Started",
                model: options.model,
                pool: "apiKeys",
                tools: [],
                harnessSession: Option.some(saved),
                session: {
                  messages: [],
                  subscribe: () => () => {},
                  prompt: (message) => {
                    prompts.push(message);
                    return run(
                      Queue.offer(prompted, undefined).pipe(Effect.andThen(Deferred.await(turn))),
                    );
                  },
                  steer: async () => "queued",
                  abort: () => run(Deferred.succeed(turn, undefined).pipe(Effect.asVoid)),
                  dispose: () => {},
                },
              };
            },
          });
          const backend = Layer.effect(
            ChildBackend,
            Effect.gen(function* () {
              const child = yield* ChildBackend;
              return {
                ...child,
                launch: (input) => {
                  sessions.push(input.session.id);
                  histories.push([...input.continuations]);
                  return child.launch(input).pipe(
                    Effect.tapError((error) =>
                      Effect.sync(() => {
                        errors.push(error._tag);
                      }),
                    ),
                  );
                },
              };
            }),
          ).pipe(Layer.provide(piChildLayer.pipe(Layer.provide(sdk))));
          const services = yield* Layer.build(
            runtimeLayer.pipe(
              Layer.provideMerge(
                harnessLayer({
                  ...fauxParent(
                    restart === 0
                      ? [delegate("Continue the task")]
                      : [answer("Finished after limit.")],
                  ),
                  openStorage: Effect.tryPromise({
                    try: () => openNodeSqliteStorage(database),
                    catch: (cause) => durableError("open continuation limit storage", cause),
                  }),
                }),
              ),
              Layer.provide(backend),
            ),
          );
          const execution = yield* Effect.forkChild(
            Context.get(services, AttemptRuntime).execute(request, recording.sink),
          );
          if (restart < 4) {
            yield* Queue.take(prompted);
            yield* Fiber.interrupt(execution);
            return;
          }
          assert.strictEqual((yield* Fiber.join(execution)).message, "Finished after limit.");
          const children = yield* Context.get(services, DurableHarness).use(
            "read continuation child budget",
            async (opened, context) =>
              (await opened.snapshot(AttemptRecordDoc, request.spec.attemptId, context))?.children,
          );
          assert.strictEqual(children, 1);
        }),
      );
    }
    assert.deepStrictEqual(
      histories.map((history) => history.length),
      [0, 0, 1, 2, 3],
    );
    assert.deepStrictEqual(histories[4]?.slice(0, 2), histories[3]);
    assert.strictEqual(new Set(sessions).size, 1);
    assert.deepStrictEqual(
      prompts.slice(1),
      Array.from({ length: 3 }, () => CONTINUATION_MESSAGE),
    );
    assert.deepStrictEqual(errors, ["ContinuationLimitError"]);
    const result = recording
      .outbound()
      .flatMap(({ payload }) =>
        payload._tag === "SessionEvent" &&
        payload.event._tag === "ToolFinished" &&
        payload.event.session._tag === "ParentSession"
          ? [payload.event]
          : [],
      );
    assert.lengthOf(result, 1);
    assert.isTrue(result[0]?.isError);
    assert.include(jsonKey(result[0]?.output), "limit of three continuations within ten minutes");
    assertAdmitted(request.spec.attemptId, recording.outbound());
  }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
);
