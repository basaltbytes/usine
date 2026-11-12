// Durable SDK callbacks use Promises.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  HarnessSession,
  HarnessSessionId,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
} from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRuntime } from "../src/attempt-runtime.ts";
import { routedRuntimeLayer as runtimeLayer } from "../src/testing.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import {
  answer,
  delegate,
  fauxParent,
  stubChildBackendLayer,
  StubChildren,
} from "../src/testing.ts";
import { assertAdmitted, attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

for (const checkpoint of [
  "conversation",
  "details",
  "usage",
  "output",
  "partial-output",
] as const) {
  it.live(
    `returns the child's report and forwards events after a failed ${checkpoint} checkpoint`,
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const request = attemptRequest(`progress/${checkpoint}`);
        const recording = recordingSink();
        const started = yield* Deferred.make<void>();
        const recorded = yield* Deferred.make<void>();
        let failCommit = false;
        let failDetails = false;
        let failOutput = false;
        let failures = 0;
        const fail = () => {
          failures += 1;
          return new Error("Transient checkpoint failure");
        };
        const harness = harnessLayer({
          ...fauxParent([delegate("Finish the task"), answer("Finished.")]),
          openStorage: Effect.tryPromise({
            try: () => openNodeSqliteStorage(database),
            catch: (cause) => durableError("open test storage", cause),
          }),
        });
        const withCheckpointFailure = Layer.effect(
          DurableHarness,
          Effect.gen(function* () {
            const durable = yield* DurableHarness;
            return {
              ...durable,
              install: (extension) =>
                durable.install({
                  ...extension,
                  wraps: [
                    {
                      tool: "subagent",
                      wrap: (tool: ToolRegistration): ToolRegistration => ({
                        ...tool,
                        execute: (args, api, context) =>
                          tool.execute(
                            args,
                            {
                              ...api,
                              commit: (change, context) => {
                                if (!failCommit) return api.commit(change, context);
                                failCommit = false;
                                return Promise.reject(fail());
                              },
                              details: (details, context) => {
                                if (!failDetails) return api.details(details, context);
                                failDetails = false;
                                return Promise.reject(fail());
                              },
                              output: (chunk, skipped) => {
                                if (!failOutput) return api.output(chunk, skipped);
                                failOutput = false;
                                throw fail();
                              },
                            },
                            context,
                          ),
                      }),
                    },
                  ],
                }),
            };
          }),
        ).pipe(Layer.provide(harness));
        yield* Effect.gen(function* () {
          const runtime = yield* AttemptRuntime;
          const execution = yield* Effect.forkChild(
            runtime.execute(request, {
              ...recording.sink,
              append: (direction, envelope) =>
                recording.sink
                  .append(direction, envelope)
                  .pipe(
                    Effect.andThen(
                      envelope._tag === "OutboundEnvelope" &&
                        envelope.payload._tag === "SessionEvent" &&
                        envelope.payload.event._tag === "TextOutput" &&
                        envelope.payload.event.text === "Checkpoint"
                        ? Deferred.succeed(recorded, undefined).pipe(Effect.asVoid)
                        : envelope._tag === "OutboundEnvelope" &&
                            envelope.payload._tag === "SessionEvent" &&
                            envelope.payload.event._tag === "SessionStarted" &&
                            envelope.payload.event.session._tag === "ChildSession"
                          ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                          : Effect.void,
                    ),
                  ),
            }),
          );
          const child = yield* (yield* StubChildren).next;
          yield* Deferred.await(started);
          failCommit = checkpoint === "conversation";
          failDetails = checkpoint === "details";
          yield* child.emit(
            SessionStarted.make({
              session: child.request.session,
              harnessSession: Option.some(
                HarnessSession.make({
                  id: HarnessSessionId.make("saved-child"),
                  cwd: request.cwd,
                }),
              ),
            }),
          );
          yield* child.emit(
            TextOutput.make({ session: child.request.session, text: "Checkpoint" }),
          );
          yield* Deferred.await(recorded);
          failCommit = checkpoint === "usage" || checkpoint === "partial-output";
          failOutput = checkpoint === "output";
          if (checkpoint === "usage")
            yield* child.emit(
              SessionTokensUpdated.make({
                session: child.request.session,
                totalTokens: TokenCount.make(100),
              }),
            );
          yield* child.reply("The child's final report.");
          assert.strictEqual((yield* Fiber.join(execution)).message, "Finished.");
          assert.strictEqual(failures, 1);
          const events = recording
            .outbound()
            .flatMap(({ payload }) => (payload._tag === "SessionEvent" ? [payload.event] : []));
          assert(
            events.some(
              (event) => event._tag === "TextOutput" && event.text === "The child's final report.",
            ),
          );
          assert(
            events.some(
              (event) =>
                event._tag === "SessionFinished" && event.session.id === child.request.session.id,
            ),
          );
          if (checkpoint === "usage")
            assert(
              events.some(
                (event) => event._tag === "SessionTokensUpdated" && event.totalTokens === 100,
              ),
            );
          const result = events.find(
            (event) => event._tag === "ToolFinished" && event.session._tag === "ParentSession",
          );
          assert(result?._tag === "ToolFinished");
          assert.isFalse(result.isError);
          assert.include(jsonKey(result.output), "The child's final report.");
          assertAdmitted(request.spec.attemptId, recording.outbound());
        }).pipe(
          Effect.provide(
            runtimeLayer.pipe(
              Layer.provideMerge(withCheckpointFailure),
              Layer.provideMerge(stubChildBackendLayer),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );
}
