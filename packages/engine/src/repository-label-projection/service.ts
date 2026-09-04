import { RepositoryName } from "@usine/core/ids";
import { eq, ne } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import { repositoryLabelProjections } from "../database/schema.ts";
import { EnginePersistenceError } from "../model.ts";
import { RepositoryLabel, RepositoryLabelProjection } from "./model.ts";

/** Rows written before colors were kept hold bare names; they read as colorless labels. */
const LegacyLabelNames = Schema.Array(Schema.String);
const isLegacyLabelNames = Schema.is(LegacyLabelNames);
const RepositoryLabelProjectionRow = Schema.Struct({
  repository: RepositoryName,
  labels: Schema.Union([RepositoryLabelProjection.fields.labels, LegacyLabelNames]),
});
const storedLabels = (
  labels: (typeof RepositoryLabelProjectionRow.Type)["labels"],
): ReadonlyArray<RepositoryLabel> =>
  isLegacyLabelNames(labels)
    ? labels.map(
        (name) => new RepositoryLabel({ name, color: Option.none(), description: Option.none() }),
      )
    : labels;

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RepositoryLabelProjectionRow));
const encodeLabels = Schema.encodeSync(RepositoryLabelProjection.fields.labels);

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

const makeReader = Effect.gen(function* () {
  const database = yield* RunDatabase;
  return {
    get: Effect.fn("RepositoryLabelProjectionReader.get")(function* (repository: RepositoryName) {
      const rows = yield* database
        .select({
          repository: repositoryLabelProjections.repository,
          labels: repositoryLabelProjections.labelsJson,
        })
        .from(repositoryLabelProjections)
        .where(eq(repositoryLabelProjections.repository, repository))
        .limit(1)
        .execute();
      const decoded = yield* decodeRows(rows, { onExcessProperty: "error" });
      const row = decoded[0];
      return row === undefined
        ? Option.none<RepositoryLabelProjection>()
        : Option.some(
            new RepositoryLabelProjection({
              repository: row.repository,
              labels: storedLabels(row.labels),
            }),
          );
    }, persistence("read repository label projection")),
  } as const;
});

const makeWriter = Effect.gen(function* () {
  const database = yield* RunDatabase;
  return {
    replace: Effect.fn("RepositoryLabelProjectionWriter.replace")(function* (
      projection: RepositoryLabelProjection,
    ) {
      yield* Effect.annotateCurrentSpan({ repository: projection.repository });
      const labelsJson = encodeLabels(projection.labels);
      const changed = yield* database
        .insert(repositoryLabelProjections)
        .values({ repository: projection.repository, labelsJson })
        .onConflictDoUpdate({
          target: repositoryLabelProjections.repository,
          set: { labelsJson },
          setWhere: ne(repositoryLabelProjections.labelsJson, labelsJson),
        })
        .returning({ repository: repositoryLabelProjections.repository })
        .execute();
      if (changed.length === 0) {
        yield* Effect.logDebug("Repository label projection already matched GitHub", {
          repository: projection.repository,
          labels: projection.labels.length,
        });
        return false;
      }
      yield* Effect.logDebug("Repository label projection updated from trigger polling", {
        repository: projection.repository,
        labels: projection.labels.length,
      });
      return true;
    }, persistence("write repository label projection")),
  } as const;
});

export class RepositoryLabelProjectionReader extends Context.Service<
  RepositoryLabelProjectionReader,
  {
    readonly get: (
      repository: RepositoryName,
    ) => Effect.Effect<Option.Option<RepositoryLabelProjection>, EnginePersistenceError>;
  }
>()("@usine/engine/RepositoryLabelProjectionReader") {
  static readonly layer = Layer.effect(RepositoryLabelProjectionReader, makeReader);
}

export class RepositoryLabelProjectionWriter extends Context.Service<
  RepositoryLabelProjectionWriter,
  {
    /** `true` means the durable projection changed. */
    readonly replace: (
      projection: RepositoryLabelProjection,
    ) => Effect.Effect<boolean, EnginePersistenceError>;
  }
>()("@usine/engine/RepositoryLabelProjectionWriter") {
  static readonly layer = Layer.effect(RepositoryLabelProjectionWriter, makeWriter);
}
