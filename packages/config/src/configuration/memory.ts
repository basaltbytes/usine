import { DateTime, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { ConfigParser } from "../parser.ts";
import { commit } from "./commit.ts";
import { Configuration, ConfigurationRevision } from "./model.ts";
import { ConfigurationStore, type ConfigurationCommit } from "./store.ts";
import { watchRevisions } from "./watch.ts";

export const memoryConfigurationLayer = Layer.effect(
  ConfigurationStore,
  Effect.gen(function* () {
    const parser = yield* ConfigParser;
    const state = yield* Ref.make<{
      configuration: Configuration;
      revisions: ReadonlyArray<ConfigurationRevision>;
    }>({
      configuration: Configuration.empty,
      revisions: [],
    });
    const lock = yield* Semaphore.make(1);
    return ConfigurationStore.of({
      read: Ref.get(state).pipe(Effect.map(({ configuration }) => configuration)),
      list: Effect.fn("ConfigurationStore.list")((entity) =>
        Ref.get(state).pipe(
          Effect.map(({ revisions }) =>
            revisions.filter(
              (revision) =>
                Option.isNone(entity) ||
                revision.changes.some(({ key }) => key.key === entity.value.key),
            ),
          ),
        ),
      ),
      revision: Effect.fn("ConfigurationStore.revision")((number) =>
        Ref.get(state).pipe(
          Effect.map(({ revisions }) =>
            Option.fromUndefinedOr(revisions.find((revision) => revision.number === number)),
          ),
        ),
      ),
      commit: Effect.fn("ConfigurationStore.commit")(
        function* (request: ConfigurationCommit) {
          yield* Effect.annotateCurrentSpan({ expectedRevision: request.expected });
          const revision = yield* Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const result = yield* commit(
              parser,
              current.configuration,
              request.expected,
              request.changes,
              {
                actor: request.actor,
                message: request.message,
                time: yield* DateTime.now,
              },
            );
            yield* Ref.set(state, {
              configuration: result.configuration,
              revisions: [...current.revisions, result.revision],
            });
            return result.revision;
          }).pipe(lock.withPermits(1));
          yield* Effect.logInfo("Configuration revision committed", {
            revision: revision.number,
            changes: revision.changes.length,
          });
          return revision;
        },
        Effect.tapError((error) =>
          Effect.logWarning("Configuration commit refused", { errorTag: error._tag }),
        ),
      ),
      changes: (after) =>
        watchRevisions(after, (number) =>
          Ref.get(state).pipe(
            Effect.map(({ revisions }) => revisions.filter((revision) => revision.number > number)),
          ),
        ),
    });
  }),
);
