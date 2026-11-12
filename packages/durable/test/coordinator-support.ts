import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { AttemptRequest } from "../src/attempt-runtime.ts";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import { attemptRequest, sqliteJournal } from "./support.ts";

/** A request whose Attempt runs without a parent session. */
export const coordinated = (attemptId: string, maxChildren = 3) => {
  const request = attemptRequest(attemptId, maxChildren);
  return AttemptRequest.make({
    ...request,
    spec: AttemptChannel.RunSpec.make({ ...request.spec, parent: "none" }),
  });
};

/** Interrupts, as a process stop does, each transition whose event has tag `tag`. */
export const interruptingTransition = (tag: string) => (journal: Layer.Layer<AttemptJournal>) =>
  Layer.effect(
    AttemptJournal,
    Effect.gen(function* () {
      const inner = yield* AttemptJournal;
      const isTagged = Schema.is(Schema.Struct({ _tag: Schema.Literal(tag) }));
      return AttemptJournal.of({
        ...inner,
        transition: (attemptId, expected, step) =>
          isTagged(step.event) ? Effect.interrupt : inner.transition(attemptId, expected, step),
      });
    }),
  ).pipe(Layer.provide(journal));

/**
 * Holds the first `load` that finds the Attempt `Terminal` until `release` completes, after
 * completing `reached`. The coordinator makes that load after it delivered the terminal envelope
 * and before its `execute` call detaches.
 */
export const holdingTerminalLoad =
  (reached: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        let held = false;
        return AttemptJournal.of({
          ...inner,
          load: (attemptId) =>
            inner.load(attemptId).pipe(
              Effect.tap((snapshot) => {
                if (held || !Option.exists(snapshot, ({ status }) => status._tag === "Terminal"))
                  return Effect.void;
                held = true;
                return Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                );
              }),
            ),
        });
      }),
    ).pipe(Layer.provide(journal));

/**
 * Holds the transition that finishes the Attempt, after completing `reached`, until `release`
 * completes. The coordinator holds the routing permit while it commits a transition.
 */
export const holdingFinish =
  (reached: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        return AttemptJournal.of({
          ...inner,
          transition: (attemptId, expected, step) =>
            (step.intents.some(({ _tag }) => _tag === "Finish")
              ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
            ).pipe(Effect.andThen(inner.transition(attemptId, expected, step))),
        });
      }),
    ).pipe(Layer.provide(journal));

/**
 * A `WakeUp` that holds its handler for events tagged `tag`, after completing `reached`, until
 * `release` completes, and then lets the rules decide.
 */
export const holdingWakeUp = (
  tag: string,
  reached: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Layer.succeed(
    WakeUp,
    WakeUp.of({
      handle: (event) =>
        event._tag === tag
          ? Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(Option.none()),
            )
          : Effect.succeedNone,
    }),
  );

/** A coordinator runtime over the journal with stub children, waking `wakeUp`. */
export const coordinatorWith =
  (wakeUp: Layer.Layer<WakeUp>) => (journal: Layer.Layer<AttemptJournal>) =>
    CoordinatorRuntime.layer.pipe(
      Layer.provide(Layer.mergeAll(journal, wakeUp)),
      Layer.provideMerge(stubChildBackendLayer),
    );

export const coordinator = coordinatorWith(WakeUp.rules);

/**
 * Starts a runtime in its own scope, as one orchestrator process. `stop` closes the scope, which
 * interrupts its `execute` calls and children as a process stop does.
 */
export const orchestrator = (layer: Layer.Layer<CoordinatorRuntime | StubChildren>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const attempts = Context.get(context, CoordinatorRuntime);
    return {
      attempts,
      nextChild: Context.get(context, StubChildren).next,
      /** Forks `execute` in the process's scope. */
      execute: (request: AttemptRequest, io: AttemptChannel.Sink) =>
        Effect.forkIn(attempts.execute(request, io), scope),
      stop: Scope.close(scope, Exit.void),
    };
  });

/** Waits until `check` holds. */
export const until = (check: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() =>
    check() ? Effect.void : Effect.sleep("10 millis").pipe(Effect.andThen(until(check))),
  );

/** Reads the Attempt's journal through a separate connection. */
export const stored = (database: string, attemptId: AttemptId) =>
  Effect.flatMap(Effect.service(AttemptJournal), (journal) => journal.load(attemptId)).pipe(
    Effect.provide(sqliteJournal(database)),
  );
