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
        const item = new ItemProjection({
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
          assert.deepStrictEqual(yield* reader.get(item.itemKey), Option.none());
          const before = yield* runs.revision();
          assert(Option.isSome(before));

          assert.strictEqual(yield* writer.upsert(item), true);
          assert.deepStrictEqual(yield* reader.get(item.itemKey), Option.some(item));
          const changed = yield* runs.revision();
          assert(Option.isSome(changed));
          assert.strictEqual(changed.value, before.value + 1);
          assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [item]);

          assert.strictEqual(yield* writer.upsert(item), false);
          assert.deepStrictEqual(yield* runs.revision(), changed);
        }).pipe(Effect.provide(fixture.open()));
      }).pipe(Effect.scoped),
    );
    it.live("records an Item GitHub no longer has as gone until a poll observes it again", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const repository = RepositoryName.make("basaltbytes/usine");
        const item = new ItemProjection({
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
          assert.strictEqual(yield* writer.markGone(item.itemKey, goneAt), false);
          yield* writer.upsert(item);
          const before = yield* runs.revision();

          assert.strictEqual(yield* writer.markGone(item.itemKey, goneAt), true);
          const gone = new ItemProjection({ ...item, goneAt: Option.some(goneAt) });
          assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [gone]);
          assert(Option.isSome(before));
          assert.deepStrictEqual(yield* runs.revision(), Option.some(before.value + 1));
          assert.strictEqual(
            yield* writer.markGone(item.itemKey, DateTime.makeUnsafe("2026-10-19T13:00:00Z")),
            false,
          );
          assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [gone]);

          // The same content observed again means GitHub has the Item after all.
          assert.strictEqual(yield* writer.upsert(item), true);
          assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [item]);
        }).pipe(Effect.provide(fixture.open()));
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
          new ItemProjection({
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
          assert.deepStrictEqual(yield* reader.openIssues(repository), [
            ItemNumber.make(12),
            ItemNumber.make(28),
          ]);
        }).pipe(Effect.provide(fixture.open()));
      }).pipe(Effect.scoped),
    );
  });
};
