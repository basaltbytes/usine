import type { LoadedInstance } from "@usine/config/instance";
import { Effect, Option, Stream } from "effect";
import type { CurrentInstance } from "./current-instance/current-instance.ts";

/** The current instance as a trigger stream reads it: the snapshot of each cycle, and the reloads that end a wait. */
export type WatchedInstance = Pick<CurrentInstance["Service"], "get" | "changes">;

/** The first snapshot other than `seen`; when the stream ends without one, it never completes. */
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
