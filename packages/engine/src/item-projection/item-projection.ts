import { type ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import { itemProjections } from "../database/schema.ts";
import { EnginePersistenceError } from "../engine/error.ts";
import { ItemContentHash, ItemProjection, ItemProjectionSource } from "./model.ts";

const ItemProjectionRow = Schema.Struct({
  itemKey: ItemProjection.fields.itemKey,
  repository: RepositoryName,
  source: ItemProjectionSource,
  number: ItemNumber,
  contentHash: ItemContentHash,
  payload: Schema.JsonObject,
  goneAt: ItemProjection.fields.goneAt,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ItemProjectionRow));
const decodeNumbers = Schema.decodeUnknownEffect(Schema.Array(ItemNumber));
const encodePayload = Schema.encodeSync(Schema.JsonObject);
const encodeGoneAt = Schema.encodeSync(ItemProjectionRow.fields.goneAt);

const persistence =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, EnginePersistenceError, R> =>
    Effect.mapError(effect, (cause) => new EnginePersistenceError({ operation, cause }));

/** The options for listing Item projections, newest first. */
export interface ItemProjectionListOptions {
  readonly limit: number;
}

const projectionSelection = {
  itemKey: itemProjections.itemKey,
  repository: itemProjections.repository,
  source: itemProjections.source,
  number: itemProjections.itemNumber,
  contentHash: itemProjections.contentHash,
  payload: itemProjections.payloadJson,
  goneAt: itemProjections.goneAt,
};

const makeReader = Effect.gen(function* () {
  const database = yield* RunDatabase;
  return {
    get: Effect.fn("ItemProjectionReader.get")(function* (itemKey: ItemKey) {
      yield* Effect.annotateCurrentSpan({ itemKey });
      const rows = yield* database
        .select(projectionSelection)
        .from(itemProjections)
        .where(eq(itemProjections.itemKey, itemKey))
        .execute();
      const [row] = yield* decodeRows(rows, { onExcessProperty: "error" });
      return Option.map(Option.fromNullishOr(row), (stored) => new ItemProjection(stored));
    }, persistence("read item projection")),
    list: Effect.fn("ItemProjectionReader.list")(function* (
      repository: RepositoryName,
      options: ItemProjectionListOptions,
    ) {
      yield* Effect.annotateCurrentSpan({ repository, limit: options.limit });
      const rows = yield* database
        .select(projectionSelection)
        .from(itemProjections)
        .where(eq(itemProjections.repository, repository))
        .orderBy(desc(itemProjections.itemNumber))
        .limit(options.limit)
        .execute();
      return (yield* decodeRows(rows, { onExcessProperty: "error" })).map(
        (row) => new ItemProjection(row),
      );
    }, persistence("list item projections")),
    openIssues: Effect.fn("ItemProjectionReader.openIssues")(function* (
      repository: RepositoryName,
    ) {
      yield* Effect.annotateCurrentSpan({ repository });
      const rows = yield* database
        .select({ number: itemProjections.itemNumber })
        .from(itemProjections)
        .where(
          and(
            eq(itemProjections.repository, repository),
            eq(itemProjections.source, "issue"),
            isNull(itemProjections.goneAt),
            sql`json_extract(${itemProjections.payloadJson}, '$.state') = 'OPEN'`,
          ),
        )
        .orderBy(asc(itemProjections.itemNumber))
        .execute();
      return yield* decodeNumbers(rows.map(({ number }) => number));
    }, persistence("list open issue projections")),
  } as const;
});

const makeWriter = Effect.gen(function* () {
  const database = yield* RunDatabase;
  return {
    upsert: Effect.fn("ItemProjectionWriter.upsert")(function* (item: ItemProjection) {
      yield* Effect.annotateCurrentSpan({
        repository: item.repository,
        item: item.number,
        itemKey: item.itemKey,
      });
      const goneAt = encodeGoneAt(item.goneAt);
      const changed = yield* database
        .insert(itemProjections)
        .values({
          itemKey: item.itemKey,
          repository: item.repository,
          source: item.source,
          itemNumber: item.number,
          contentHash: item.contentHash,
          payloadJson: encodePayload(item.payload),
          goneAt,
        })
        .onConflictDoUpdate({
          target: itemProjections.itemKey,
          set: {
            repository: item.repository,
            source: item.source,
            itemNumber: item.number,
            contentHash: item.contentHash,
            payloadJson: encodePayload(item.payload),
            goneAt,
          },
          setWhere: sql`${itemProjections.contentHash} != ${item.contentHash} OR ${itemProjections.goneAt} IS NOT ${goneAt}`,
        })
        .returning({ itemKey: itemProjections.itemKey })
        .execute();
      if (changed.length === 0) {
        yield* Effect.logDebug("Item projection already matched the observed snapshot", {
          repository: item.repository,
          item: item.number,
          contentHash: item.contentHash,
        });
        return false;
      }
      yield* Effect.logDebug("Item projection updated from trigger polling", {
        repository: item.repository,
        item: item.number,
        source: item.source,
        contentHash: item.contentHash,
      });
      return true;
    }, persistence("write item projection")),
    markGone: Effect.fn("ItemProjectionWriter.markGone")(function* (
      itemKey: ItemKey,
      goneAt: DateTime.Utc,
    ) {
      yield* Effect.annotateCurrentSpan({ itemKey });
      const marked = yield* database
        .update(itemProjections)
        .set({ goneAt: encodeGoneAt(Option.some(goneAt)) })
        .where(and(eq(itemProjections.itemKey, itemKey), isNull(itemProjections.goneAt)))
        .returning({ itemKey: itemProjections.itemKey })
        .execute();
      if (marked.length === 0) {
        yield* Effect.logDebug("Item projection already gone or never stored", { itemKey });
        return false;
      }
      yield* Effect.logInfo("Item projection marked gone from GitHub", {
        itemKey,
        goneAt: DateTime.formatIso(goneAt),
      });
      return true;
    }, persistence("mark item projection gone")),
  } as const;
});

export class ItemProjectionReader extends Context.Service<
  ItemProjectionReader,
  {
    /** Returns the stored projection of the Item `itemKey`, or `None` if no trigger observed it. */
    readonly get: (
      itemKey: ItemKey,
    ) => Effect.Effect<Option.Option<ItemProjection>, EnginePersistenceError>;
    /** Returns the newest `limit` Item projections of `repository`, highest number first. */
    readonly list: (
      repository: RepositoryName,
      options: ItemProjectionListOptions,
    ) => Effect.Effect<ReadonlyArray<ItemProjection>, EnginePersistenceError>;
    /** Returns the numbers of `repository`'s open issues that aren't marked gone, lowest first, without a limit. */
    readonly openIssues: (
      repository: RepositoryName,
    ) => Effect.Effect<ReadonlyArray<ItemNumber>, EnginePersistenceError>;
  }
>()("@usine/engine/ItemProjectionReader") {
  static readonly layer = Layer.effect(ItemProjectionReader, makeReader);
}

export class ItemProjectionWriter extends Context.Service<
  ItemProjectionWriter,
  {
    /** Stores `item`, clearing `goneAt` for an observed snapshot. Returns whether the stored projection changed. */
    readonly upsert: (item: ItemProjection) => Effect.Effect<boolean, EnginePersistenceError>;
    /**
     * Records that GitHub no longer has the Item, keeping its last payload. Returns whether a
     * stored projection was marked; an Item already gone keeps its first `goneAt`.
     */
    readonly markGone: (
      itemKey: ItemKey,
      goneAt: DateTime.Utc,
    ) => Effect.Effect<boolean, EnginePersistenceError>;
  }
>()("@usine/engine/ItemProjectionWriter") {
  static readonly layer = Layer.effect(ItemProjectionWriter, makeWriter);
}

export { ItemContentHash, ItemProjection, ItemProjectionSource } from "./model.ts";
