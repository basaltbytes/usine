import { Loop } from "@usine/core";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { RunDatabase } from "./database/database.ts";
import { loopRuntime } from "./database/schema.ts";
import { EnginePersistenceError, LoopRuntimeState } from "./model.ts";

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    effect.pipe(Effect.mapError((cause) => new EnginePersistenceError({ operation, cause })));

const makeLoopControl = Effect.gen(function* () {
  const database = yield* RunDatabase;

  const stateFor = Effect.fn("LoopControl.stateFor")(function* (loop: Loop.LoopName) {
    yield* Effect.annotateCurrentSpan({ loop });
    const rows = yield* database
      .select({ loop: loopRuntime.loopName, paused: loopRuntime.paused })
      .from(loopRuntime)
      .where(eq(loopRuntime.loopName, loop))
      .limit(1)
      .execute();
    const stored = rows[0];
    return stored === undefined
      ? new LoopRuntimeState({ loop, paused: false })
      : new LoopRuntimeState(stored);
  }, persistence("read Loop runtime state"));

  const states = Effect.fn("LoopControl.states")(function* () {
    const rows = yield* database
      .select({ loop: loopRuntime.loopName, paused: loopRuntime.paused })
      .from(loopRuntime)
      .orderBy(asc(loopRuntime.loopName))
      .execute();
    return rows.map((row) => new LoopRuntimeState(row));
  }, persistence("list Loop runtime states"));

  const write = Effect.fn("LoopControl.write")(function* (next: LoopRuntimeState) {
    yield* Effect.annotateCurrentSpan({ loop: next.loop });
    const current = yield* stateFor(next.loop);
    if (current.paused === next.paused) {
      yield* Effect.logDebug("Loop runtime state was already set", {
        loop: next.loop,
        paused: next.paused,
      });
      return current;
    }
    yield* database
      .insert(loopRuntime)
      .values({ loopName: next.loop, paused: next.paused })
      .onConflictDoUpdate({
        target: loopRuntime.loopName,
        set: { paused: next.paused },
      })
      .execute()
      .pipe(persistence("write Loop runtime state"));
    yield* Effect.logInfo(next.paused ? "Loop paused" : "Loop unpaused", {
      loop: next.loop,
      paused: next.paused,
    });
    return next;
  });

  return {
    isPaused: Effect.fn("LoopControl.isPaused")(function* (loop: Loop.LoopName) {
      return (yield* stateFor(loop)).paused;
    }),
    pause: Effect.fn("LoopControl.pause")((loop: Loop.LoopName) =>
      write(new LoopRuntimeState({ loop, paused: true })),
    ),
    states: states(),
    unpause: Effect.fn("LoopControl.unpause")((loop: Loop.LoopName) =>
      write(new LoopRuntimeState({ loop, paused: false })),
    ),
  } as const;
});

/** Durable operator control over Loop runtime state. It never edits the instance repo. */
export class LoopControl extends Context.Service<
  LoopControl,
  {
    readonly isPaused: (loop: Loop.LoopName) => Effect.Effect<boolean, EnginePersistenceError>;
    readonly pause: (
      loop: Loop.LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    readonly states: Effect.Effect<ReadonlyArray<LoopRuntimeState>, EnginePersistenceError>;
    readonly unpause: (
      loop: Loop.LoopName,
    ) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
  }
>()("@usine/engine/LoopControl") {
  static readonly layer = Layer.effect(LoopControl, makeLoopControl);
}
