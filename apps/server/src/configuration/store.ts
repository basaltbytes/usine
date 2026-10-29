import { ConfigurationStore, ConfigurationStoreError } from "@usine/config/configuration";
import { LoopName } from "@usine/core/loop";
import { LoopControl } from "@usine/engine/loop-control";
import { Effect, Layer, Option } from "effect";

/** The caller must commit the revision and loop controls in one transaction. */
export const configurationLoopControlLayer = Layer.effect(
  ConfigurationStore,
  Effect.gen(function* () {
    const store = yield* ConfigurationStore;
    const controls = yield* LoopControl;
    return ConfigurationStore.of({
      ...store,
      commit: Effect.fn("Server.commitConfiguration")(function* (request) {
        const before = yield* store.read;
        const revision = yield* store.commit(request);
        const after = yield* store.read;
        if (
          Option.isSome(before.instance) &&
          before.instance.value.config.version === 1 &&
          Option.isSome(after.instance) &&
          after.instance.value.config.version === 2
        ) {
          yield* Effect.logInfo("Project migration preserves loop pause states", {
            revision: revision.number,
          });
          return revision;
        }
        yield* Effect.annotateCurrentSpan({ expectedRevision: request.expected });
        if (request.expected === 0) {
          yield* Effect.logInfo("Initial configuration import preserves loop pause states", {
            revision: revision.number,
          });
          return revision;
        }
        for (const change of revision.changes) {
          if (
            change.key.kind !== "loop" ||
            Option.isSome(change.before) ||
            Option.isNone(change.after)
          )
            continue;
          yield* controls
            .pause(LoopName.make(change.key.identifier))
            .pipe(
              Effect.mapError(
                (cause) => new ConfigurationStoreError({ operation: "pause created loop", cause }),
              ),
            );
          yield* Effect.logInfo("Created loop starts paused", {
            loop: change.key.identifier,
            revision: revision.number,
          });
        }
        return revision;
      }),
    });
  }),
);
