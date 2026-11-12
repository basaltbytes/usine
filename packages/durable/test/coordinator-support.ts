import { SqliteClient } from "@effect/sql-sqlite-node";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { AttemptRequest } from "../src/attempt-runtime.ts";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { sqliteAttemptJournalLayer } from "../src/coordinator/sqlite/store.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import { attemptRequest } from "./support.ts";

/** A request whose Attempt runs without a parent session. */
export const coordinated = (attemptId: string, maxChildren = 3) => {
  const request = attemptRequest(attemptId, maxChildren);
  return AttemptRequest.make({
    ...request,
    spec: AttemptChannel.RunSpec.make({ ...request.spec, parent: "none" }),
  });
};

export const sqliteJournal = (database: string) =>
  sqliteAttemptJournalLayer.pipe(
    Layer.provide(SqliteClient.layer({ filename: database })),
    Layer.orDie,
  );

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
