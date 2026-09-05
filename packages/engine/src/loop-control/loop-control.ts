import { LoopName } from "@usine/core/loop";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { RunDatabase } from "../database/database.ts";
import { loopRuntime } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";
import { LoopRuntimeState } from "./model.ts";

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    effect.pipe(Effect.mapError((cause) => new EnginePersistenceError({ operation, cause })));

const makeLoopControl = Effect.gen(function* () {
  const database = yield* RunDatabase;

  const stateFor = Effect.fn("LoopControl.stateFor")(function* (loop: LoopName) {
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
    isPaused: Effect.fn("LoopControl.isPaused")(function* (loop: LoopName) {
      return (yield* stateFor(loop)).paused;
    }),
    pause: Effect.fn("LoopControl.pause")((loop: LoopName) =>
      write(new LoopRuntimeState({ loop, paused: true })),
    ),
    states: states(),
    unpause: Effect.fn("LoopControl.unpause")((loop: LoopName) =>
      write(new LoopRuntimeState({ loop, paused: false })),
    ),
  } as const;
});

/** Records whether triggers may open new Runs for each Loop; existing Runs and authored files stay unchanged. */
export class LoopControl extends Context.Service<
  LoopControl,
  {
    /** Whether new Runs are paused; a Loop with no recorded runtime state is unpaused. */
    readonly isPaused: (loop: LoopName) => Effect.Effect<boolean, EnginePersistenceError>;
    /** Pauses new trigger work for this Loop without stopping its existing Runs. */
    readonly pause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
    /** Recorded runtime states ordered by Loop name; Loops without stored state are omitted. */
    readonly states: Effect.Effect<ReadonlyArray<LoopRuntimeState>, EnginePersistenceError>;
    /** Allows triggers to open new Runs for this Loop again. */
    readonly unpause: (loop: LoopName) => Effect.Effect<LoopRuntimeState, EnginePersistenceError>;
  }
>()("@usine/engine/LoopControl") {
  static readonly layer = Layer.effect(LoopControl, makeLoopControl);
}

export { LoopRuntimeState } from "./model.ts";
