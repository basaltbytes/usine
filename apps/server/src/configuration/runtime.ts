import { NodeServices } from "@effect/platform-node";
import {
  ConfigurationStore,
  ConfigurationStoreError,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { sqliteConfigurationLayer } from "@usine/config/sqlite";
import type { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, Layer, Option } from "effect";

const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));

export const configurationLayer = Layer.mergeAll(
  sqliteConfigurationLayer,
  ConfigurationFolder.layer,
).pipe(Layer.provideMerge(parser), Layer.provide(NodeServices.layer));

/** Imports files only while the configuration tables are empty. */
export const initializeConfiguration = Effect.fn("Server.initializeConfiguration")(function* (
  directory: InstanceDirectory,
) {
  yield* Effect.annotateCurrentSpan({ directory });
  const store = yield* ConfigurationStore;
  const current = yield* store.read;
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
