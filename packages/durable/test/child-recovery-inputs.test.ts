// Durable storage transactions use Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChildBackend, ChildSessionJournal, SessionInterruptedError } from "@usine/agents/runtime";
import { HarnessSession, SessionStarted, TextOutput } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { jsonKey } from "@usine/core/json-key";
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRuntime } from "../src/attempt-runtime.ts";
import { SubagentDoc } from "../src/attempt/child.ts";
import { layer as runtimeLayer } from "../src/attempt/runtime.ts";
import { DurableHarness, durableError, layer as harnessLayer } from "../src/harness.ts";
import {
  answer,
  delegate,
  fauxParent,
  layer,
  stubChildBackendLayer,
  StubChildren,
} from "../src/testing.ts";
import { attemptRequest, recordingSink, temporaryDatabase } from "./support.ts";

/** Fails every native reopen and records the unread messages each reopen received. */
const failedReopen = (restored: Array<ReadonlyArray<string>>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const services = yield* Effect.context<ChildBackend | StubChildren>();
      const backend = Context.get(services, ChildBackend);
      return Context.add(services, ChildBackend, {
        ...backend,
        launch: (request) =>
          Option.isSome(request.resume)
            ? Effect.sync(() => restored.push(request.unread.map(({ message }) => message))).pipe(
                Effect.andThen(
                  SessionInterruptedError.make({
                    sessionId: request.session.id,
                    message: "Native reopen failed",
                  }),
                ),
              )
            : backend.launch(request),
      });
    }),
  ).pipe(Layer.provide(stubChildBackendLayer));

for (const failure of ["harness-mismatch", "native-reopen"] as const) {
  it.live(`returns a restored forwarded steer to the parent after ${failure}`, () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = attemptRequest(`steering/recovery/${failure}`);
      const recording = recordingSink();
      const restored: Array<ReadonlyArray<string>> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            layer({ database, parent: [delegate("Fix the findings.")] }),
          );
          const runtime = Context.get(services, AttemptRuntime);
          const committed = yield* Deferred.make<void>();
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
                        envelope.payload.event._tag === "TextOutput"
                        ? Deferred.succeed(committed, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            }),
          );
          const child = yield* Context.get(services, StubChildren).next;
          yield* child.emit(
            SessionStarted.make({
              session: child.request.session,
              harnessSession: Option.some(HarnessSession.make({ cwd: request.cwd })),
            }),
          );
          yield* child.emit(
            TextOutput.make({ session: child.request.session, text: "Partial progress" }),
          );
          yield* Deferred.await(committed);
          yield* runtime.intervene(
            request.spec.attemptId,
            AttemptChannel.Intervention.make({
              operator: "PhilDL",
              target: AttemptChannel.ParentTarget.make(),
              action: AttemptChannel.Steer.make({ message: "Fix the third finding." }),
            }),
          );
          if (failure === "harness-mismatch")
            yield* Context.get(services, DurableHarness).use(
              "change the saved harness",
              (opened, context) =>
                opened.commit(async (tx) => {
                  const tasks = await tx.scanTasks({ kind: "pi.tool" }, 100);
                  const task = tasks.items[0];
                  assert(task !== undefined);
                  const record = await tx.doc(SubagentDoc, task.id);
                  assert(record.saved !== null);
                  Object.assign(record.saved.session.brain, { harness: "codex" });
                }, context),
            );
          yield* Fiber.interrupt(execution);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            runtimeLayer.pipe(
              Layer.provideMerge(
                harnessLayer({
                  ...fauxParent([
                    answer("The earlier work is done."),
                    (context) => {
                      assert.include(jsonKey(context.messages.at(-1)), "Fix the third finding.");
                      return answer("Handled the returned steer.");
                    },
                  ]),
                  openStorage: Effect.tryPromise({
                    try: () => openNodeSqliteStorage(database),
                    catch: (cause) => durableError("open recovery storage", cause),
                  }),
                }),
              ),
              Layer.provideMerge(failedReopen(restored)),
            ),
          );
          const result = yield* Context.get(services, AttemptRuntime).execute(
            request,
            recording.sink,
          );
          assert.strictEqual(result.message, "Handled the returned steer.");
          const receipts = recording
            .outbound()
            .flatMap(({ payload }) =>
              payload._tag === "InterventionApplied" ? [payload.state.queued] : [],
            );
          assert.deepStrictEqual(receipts, [true, true, false]);
          // The replayed call restores the steer before the relay can return it.
          assert.deepStrictEqual(
            restored,
            failure === "native-reopen" ? [["Fix the third finding."]] : [],
          );
        }),
      );
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  );
}

it.live(
  "keeps an in-process native reopen failure as infrastructure when the parent reports a blocker",
  () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const backend = Layer.effectContext(
        Effect.gen(function* () {
          const services = yield* Effect.context<ChildBackend | StubChildren>();
          const original = Context.get(services, ChildBackend);
          return Context.add(services, ChildBackend, {
            ...original,
            launch: (request) =>
              original.launch(request).pipe(
                Effect.map((child) => ({
                  ...child,
                  result: child.result.pipe(
                    Effect.mapError((error) =>
                      error._tag === "SessionOperationError"
                        ? SessionInterruptedError.make({
                            sessionId: request.session.id,
                            message: "Native reopen failed",
                            cause: Option.some(error),
                          })
                        : error,
                    ),
                  ),
                })),
              ),
          });
        }),
      ).pipe(Layer.provide(stubChildBackendLayer));
      yield* Effect.gen(function* () {
        const execution = yield* Effect.forkChild(
          (yield* AttemptRuntime).execute(
            attemptRequest("recovery/in-process-failure"),
            recordingSink().sink,
          ),
        );
        yield* (yield* (yield* StubChildren).next).crash("Connection lost");
        const failure = yield* Fiber.join(execution).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.strictEqual(failure.message, "Native reopen failed");
      }).pipe(
        Effect.provide(
          runtimeLayer.pipe(
            Layer.provideMerge(
              harnessLayer({
                ...fauxParent([
                  delegate("Complete the task"),
                  answer("[usine:blocked]\nThe SSH connection failed."),
                ]),
                openStorage: Effect.tryPromise({
                  try: () => openNodeSqliteStorage(database),
                  catch: (cause) => durableError("open recovery storage", cause),
                }),
              }),
            ),
            Layer.provideMerge(backend),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
);

it.live("reports a restored forwarded steer read by the resumed child", () =>
  Effect.gen(function* () {
    const database = yield* temporaryDatabase;
    const request = attemptRequest("steering/recovery/read");
    const recording = recordingSink();
    let childSessionId = "";
    yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(
          layer({ database, parent: [delegate("Fix the findings.")] }),
        );
        const runtime = Context.get(services, AttemptRuntime);
        const committed = yield* Deferred.make<void>();
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
                      envelope.payload.event._tag === "TextOutput"
                      ? Deferred.succeed(committed, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
          }),
        );
        const child = yield* Context.get(services, StubChildren).next;
        childSessionId = child.request.session.id;
        yield* child.emit(
          SessionStarted.make({
            session: child.request.session,
            harnessSession: Option.some(HarnessSession.make({ cwd: request.cwd })),
          }),
        );
        yield* child.emit(
          TextOutput.make({ session: child.request.session, text: "Partial progress" }),
        );
        yield* Deferred.await(committed);
        yield* runtime.intervene(
          request.spec.attemptId,
          AttemptChannel.Intervention.make({
            operator: "PhilDL",
            target: AttemptChannel.ParentTarget.make(),
            action: AttemptChannel.Steer.make({ message: "Fix the third finding." }),
          }),
        );
        yield* Fiber.interrupt(execution);
      }),
    );
    const beforeRestart = recording.outbound().length;
    // The resumed child reads its restored message as soon as it starts.
    const readOnReopen = Layer.effectContext(
      Effect.gen(function* () {
        const services = yield* Effect.context<ChildBackend | StubChildren>();
        const backend = Context.get(services, ChildBackend);
        return Context.add(services, ChildBackend, {
          ...backend,
          launch: (child) =>
            Effect.gen(function* () {
              const running = yield* backend.launch(child);
              const journal = yield* ChildSessionJournal.current;
              const state = AttemptChannel.InterventionState.make({ held: false, paused: false });
              for (const { id } of child.unread) yield* journal.delivered(id, Option.some(state));
              return running;
            }),
        });
      }),
    ).pipe(Layer.provide(stubChildBackendLayer));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(
          runtimeLayer.pipe(
            Layer.provideMerge(
              harnessLayer({
                ...fauxParent([answer("Handled the finding.")]),
                openStorage: Effect.tryPromise({
                  try: () => openNodeSqliteStorage(database),
                  catch: (cause) => durableError("open recovery storage", cause),
                }),
              }),
            ),
            Layer.provideMerge(readOnReopen),
          ),
        );
        const execution = yield* Effect.forkChild(
          Context.get(services, AttemptRuntime).execute(request, recording.sink),
        );
        const resumed = yield* Context.get(services, StubChildren).next;
        assert.deepStrictEqual(
          resumed.request.unread.map(({ message }) => message),
          ["Fix the third finding."],
        );
        yield* resumed.reply("Fixed the third finding.");
        const result = yield* Fiber.join(execution);
        assert.strictEqual(result.message, "Handled the finding.");
        const afterRestart = recording.outbound().slice(beforeRestart);
        const receipts = afterRestart.flatMap(({ payload }) =>
          payload._tag === "InterventionApplied" ? [payload.state] : [],
        );
        assert.lengthOf(receipts, 1);
        assert.isFalse(receipts[0]?.queued);
        assert.deepStrictEqual(receipts[0]?.forwardedTo, Option.some(childSessionId));
        // A replayed call does not send the task prompt again.
        const started = afterRestart.flatMap(({ payload }) =>
          payload._tag === "SessionEvent" &&
          payload.event._tag === "SessionStarted" &&
          payload.event.session.id === childSessionId
            ? [payload.event]
            : [],
        );
        assert.lengthOf(started, 1);
        assert.deepStrictEqual(started[0]?.prompt, Option.none());
      }),
    );
  }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
);
