import { assert, describe, it } from "@effect/vitest";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Option } from "effect";

import {
  ItemProjectionReader,
  ItemProjectionWriter,
} from "../../src/item-projection/item-projection.ts";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "../../src/item-projection/model.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { type PersistenceAdapter } from "./adapter.ts";

export const itemProjectionContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} Item projections contract`, () => {
    it.live("stores the latest polled Item without invalidating unchanged operator reads", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const repository = RepositoryName.make("basaltbytes/usine");
        const item = ItemProjection.make({
          itemKey: ItemKey.make("github:basaltbytes/usine:33"),
          repository,
          source: ItemProjectionSource.make("issue"),
          number: ItemNumber.make(33),
          contentHash: ItemContentHash.make("content-1"),
          payload: { number: 33, title: "Board lanes" },
        });

        yield* Effect.gen(function* () {
          const reader = yield* ItemProjectionReader;
          const writer = yield* ItemProjectionWriter;
          const runs = yield* RunReader;
          const snapshot = yield* reader.get(item.itemKey);
          assert.deepStrictEqual(snapshot, Option.none());
          const before = yield* runs.revision;
          assert(Option.isSome(before));

          const currentChanged = yield* writer.upsert(item);
          assert.strictEqual(currentChanged, true);
          const currentSnapshot = yield* reader.get(item.itemKey);
          assert.deepStrictEqual(currentSnapshot, Option.some(item));
          const changed = yield* runs.revision;
          assert(Option.isSome(changed));
          assert.strictEqual(changed.value, before.value + 1);
          const entries = yield* reader.list(repository, { limit: 10 });
          assert.deepStrictEqual(entries, [item]);

          const nextChanged = yield* writer.upsert(item);
          assert.strictEqual(nextChanged, false);
          const currentRevision = yield* runs.revision;
          assert.deepStrictEqual(currentRevision, changed);
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.live("records an Item GitHub no longer has as gone until a poll observes it again", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const repository = RepositoryName.make("basaltbytes/usine");
        const item = ItemProjection.make({
          itemKey: ItemKey.make("github:basaltbytes/usine:28"),
          repository,
          source: ItemProjectionSource.make("pr"),
          number: ItemNumber.make(28),
          contentHash: ItemContentHash.make("content-28"),
          payload: { number: 28, state: "OPEN" },
        });
        const goneAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");

        yield* Effect.gen(function* () {
          const reader = yield* ItemProjectionReader;
          const writer = yield* ItemProjectionWriter;
          const runs = yield* RunReader;
          const changed = yield* writer.markGone(item.itemKey, goneAt);
          assert.strictEqual(changed, false);
          yield* writer.upsert(item);
          const before = yield* runs.revision;

          const currentChanged = yield* writer.markGone(item.itemKey, goneAt);
          assert.strictEqual(currentChanged, true);
          const gone = ItemProjection.make({ ...item, goneAt: Option.some(goneAt) });
          const entries = yield* reader.list(repository, { limit: 10 });
          assert.deepStrictEqual(entries, [gone]);
          assert(Option.isSome(before));
          const currentRevision = yield* runs.revision;
          assert.deepStrictEqual(currentRevision, Option.some(before.value + 1));
          const nextChanged = yield* writer.markGone(
            item.itemKey,
            DateTime.makeUnsafe("2026-10-19T13:00:00Z"),
          );
          assert.strictEqual(nextChanged, false);
          const currentEntries = yield* reader.list(repository, { limit: 10 });
          assert.deepStrictEqual(currentEntries, [gone]);

          // The same content observed again means GitHub has the Item after all.
          const updatedChanged = yield* writer.upsert(item);
          assert.strictEqual(updatedChanged, true);
          const nextEntries = yield* reader.list(repository, { limit: 10 });
          assert.deepStrictEqual(nextEntries, [item]);
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.live("lists the open issues of one repository that are not marked gone", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const repository = RepositoryName.make("basaltbytes/usine");
        const projection = (
          source: "issue" | "pr",
          number: number,
          state: string,
          owner: RepositoryName = repository,
        ) =>
          ItemProjection.make({
            itemKey: ItemKey.make(`github:${owner}:${number}`),
            repository: owner,
            source: ItemProjectionSource.make(source),
            number: ItemNumber.make(number),
            contentHash: ItemContentHash.make(`content-${number}`),
            payload: { number, state },
          });

        yield* Effect.gen(function* () {
          const reader = yield* ItemProjectionReader;
          const writer = yield* ItemProjectionWriter;
          for (const stored of [
            projection("issue", 28, "OPEN"),
            projection("issue", 12, "OPEN"),
            projection("issue", 29, "CLOSED"),
            projection("pr", 30, "OPEN"),
            projection("issue", 31, "OPEN"),
            projection("issue", 32, "OPEN", RepositoryName.make("basaltbytes/other")),
          ]) {
            yield* writer.upsert(stored);
          }
          yield* writer.markGone(
            ItemKey.make(`github:${repository}:31`),
            DateTime.makeUnsafe("2026-10-20T12:00:00Z"),
          );
          const currentOpenIssues = yield* reader.openIssues(repository);
          assert.deepStrictEqual(currentOpenIssues, [ItemNumber.make(12), ItemNumber.make(28)]);
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
  });
};
