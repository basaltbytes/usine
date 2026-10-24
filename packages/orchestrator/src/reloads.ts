import type { LoadedInstance } from "@usine/config/instance";
import { Effect, Option, Stream } from "effect";
import type { CurrentInstance } from "./current-instance/current-instance.ts";

/**
 * The current instance as a trigger stream reads it: each cycle's snapshot, and the reloads that
 * end a wait.
 */
export type WatchedInstance = Pick<CurrentInstance["Service"], "get" | "changes">;

/**
 * Completes with the first snapshot other than `seen`. Never completes if the stream ends without
 * one.
 */
export const reloadedFrom = (
  instances: WatchedInstance,
  seen: LoadedInstance,
): Effect.Effect<LoadedInstance> =>
  instances.changes.pipe(
    Stream.filter((instance) => instance !== seen),
    Stream.runHead,
    Effect.flatMap(
      Option.match({ onNone: () => Effect.never, onSome: (instance) => Effect.succeed(instance) }),
    ),
  );
