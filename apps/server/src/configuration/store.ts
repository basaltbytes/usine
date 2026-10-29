import { ConfigurationStore, ConfigurationStoreError } from "@usine/config/configuration";
import { LoopName } from "@usine/core/loop";
import { LoopControl } from "@usine/engine/loop-control";
import { RepositoryProject, migrateProjectLoops } from "@usine/engine/database";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

const isLegacySettings = Schema.is(Schema.Struct({ version: Schema.Literal(1) }));
const isProjectSettings = Schema.is(Schema.Struct({ version: Schema.Literal(2) }));

/** The caller must commit the revision and loop controls in one transaction. */
export const configurationLoopControlLayer = Layer.effect(
  ConfigurationStore,
  Effect.gen(function* () {
    const store = yield* ConfigurationStore;
    const controls = yield* LoopControl;
    const sql = yield* SqlClient.SqlClient;
    return ConfigurationStore.of({
      ...store,
      commit: Effect.fn("Server.commitConfiguration")(function* (request) {
        yield* Effect.annotateCurrentSpan({ expectedRevision: request.expected });
        const revision = yield* store.commit(request);
        if (
          revision.changes.some(
            (change) =>
              change.key.kind === "settings" &&
              (Option.isNone(change.before) || isLegacySettings(change.before.value)) &&
              Option.isSome(change.after) &&
              isProjectSettings(change.after.value),
          )
        ) {
          const current = yield* store.read;
          if (Option.isNone(current.instance))
            return yield* new ConfigurationStoreError({
              operation: "migrate runtime project identities",
              cause: "Configuration is empty after commit",
            });
          const instance = current.instance.value;
          yield* migrateProjectLoops(
            instance.config.projects.flatMap((project) =>
              project.repositories.map(
                (repository) =>
                  new RepositoryProject({
                    repository,
                    project: project.id,
                    loops: instance.loops
                      .filter((loop) => loop.name.startsWith(`${project.id}/`))
                      .map((loop) => loop.name),
                  }),
              ),
            ),
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new ConfigurationStoreError({
                  operation: "migrate runtime project identities",
                  cause,
                }),
            ),
          );
          yield* Effect.logInfo("Project migration preserves loop pause states", {
            revision: revision.number,
          });
          return revision;
        }
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
