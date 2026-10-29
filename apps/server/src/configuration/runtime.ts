import { NodeServices } from "@effect/platform-node";
import {
  ConfigurationStore,
  ConfigurationStoreError,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { migrateProjects } from "@usine/config/project";
import { RepositoryProject, migrateProjectLoops } from "@usine/engine/database";
import { ConfigParser } from "@usine/config/parser";
import { sqliteConfigurationLayer } from "@usine/config/sqlite";
import type { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { LoopControl } from "@usine/engine/loop-control";
import { SqlClient } from "effect/sql";
import { configurationLoopControlLayer } from "./store.ts";
import { Effect, Layer, Option } from "effect";

const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));

const controlledStore = configurationLoopControlLayer.pipe(
  Layer.provide(sqliteConfigurationLayer),
  Layer.provide(LoopControl.layer),
);
const transactionalStore = Layer.effect(
  ConfigurationStore,
  Effect.gen(function* () {
    const store = yield* ConfigurationStore;
    const sql = yield* SqlClient.SqlClient;
    return ConfigurationStore.of({
      ...store,
      commit: Effect.fn("Server.commitConfigurationTransaction")((request) =>
        Effect.gen(function* () {
          const before = yield* store.read;
          const revision = yield* store.commit(request);
          const after = yield* store.read;
          if (
            Option.isSome(after.instance) &&
            after.instance.value.config.version === 2 &&
            (Option.isNone(before.instance) || before.instance.value.config.version === 1)
          ) {
            yield* migrateProjectLoops(
              after.instance.value.config.projects.flatMap((project) =>
                project.repositories.map(
                  (repository) => new RepositoryProject({ repository, project: project.id }),
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
          }
          return revision;
        }).pipe(
          sql.withTransaction,
          Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(
              new ConfigurationStoreError({
                operation: "commit configuration and loop controls",
                cause,
              }),
            ),
          ),
          Effect.tap((revision) =>
            Effect.logInfo("Configuration revision and loop controls committed", {
              revision: revision.number,
            }),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Configuration transaction rolled back", {
              errorTag: error._tag,
              expectedRevision: request.expected,
            }),
          ),
        ),
      ),
    });
  }),
).pipe(Layer.provide(controlledStore));

export const configurationLayer = Layer.mergeAll(
  transactionalStore,
  ConfigurationFolder.layer,
).pipe(Layer.provideMerge(parser), Layer.provide(NodeServices.layer));

/** Imports files only while the configuration tables are empty. */
export const initializeConfiguration = Effect.fn("Server.initializeConfiguration")(function* (
  directory: InstanceDirectory,
) {
  yield* Effect.annotateCurrentSpan({ directory });
  const store = yield* ConfigurationStore;
  const current = yield* store.read;
  if (Option.isSome(current.instance) && current.instance.value.config.version === 1) {
    const migrated = migrateProjects(current.instance.value);
    yield* store
      .commit({
        expected: current.number,
        actor: current.actor,
        message: Option.some("Migrated repositories and loops to projects"),
        changes: configurationDiff(
          configurationEntities(current.instance.value),
          configurationEntities(migrated),
        ),
      })
      .pipe(
        Effect.catchTag("StaleRevision", () =>
          Effect.logInfo("Another process migrated projects first"),
        ),
      );
    const saved = yield* store.read;
    if (Option.isSome(saved.instance))
      return { instance: saved.instance.value, number: saved.number };
  }
  if (Option.isSome(current.instance)) {
    yield* Effect.logInfo("Loaded stored configuration", { revision: current.number });
    return { instance: current.instance.value, number: current.number };
  }
  const folder = yield* ConfigurationFolder;
  const imported = yield* folder.load(directory);
  yield* store
    .commit({
      expected: current.number,
      actor: imported.config.operator,
      message: Option.some("Imported from the instance folder"),
      changes: configurationDiff([], configurationEntities(imported)),
    })
    .pipe(
      Effect.catchTag("StaleRevision", () =>
        Effect.logInfo("Another process imported the configuration first"),
      ),
    );
  const initialized = yield* store.read;
  if (Option.isNone(initialized.instance))
    return yield* new ConfigurationStoreError({
      operation: "initialize configuration",
      cause: "Configuration is empty after import",
    });
  return { instance: initialized.instance.value, number: initialized.number };
});
