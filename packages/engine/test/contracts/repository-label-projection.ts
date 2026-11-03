import { assert, describe, it } from "@effect/vitest";
import { RepositoryName } from "@usine/core/repository";
import { Effect, Option } from "effect";

import {
  RepositoryLabel,
  RepositoryLabelProjection,
} from "../../src/repository-label-projection/model.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../../src/repository-label-projection/repository-label-projection.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { type PersistenceAdapter } from "./adapter.ts";

export const repositoryLabelProjectionContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} Repository label projections contract`, () => {
    it.live("stores the complete catalog and invalidates only changed operator reads", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const repository = RepositoryName.make("basaltbytes/usine");
        const projection = new RepositoryLabelProjection({
          repository,
          labels: [
            new RepositoryLabel({
              name: "bug",
              color: Option.some("d73a4a"),
              description: Option.some("Something is broken"),
            }),
            new RepositoryLabel({
              name: "unused-ready-label",
              color: Option.none(),
              description: Option.none(),
            }),
          ],
        });

        yield* Effect.gen(function* () {
          const reader = yield* RepositoryLabelProjectionReader;
          const writer = yield* RepositoryLabelProjectionWriter;
          const runs = yield* RunReader;
          const before = yield* runs.revision();
          assert(Option.isSome(before));

          assert.strictEqual(yield* writer.replace(projection), true);
          const changed = yield* runs.revision();
          assert(Option.isSome(changed));
          assert.strictEqual(changed.value, before.value + 1);
          assert.deepStrictEqual(yield* reader.get(repository), Option.some(projection));

          assert.strictEqual(yield* writer.replace(projection), false);
          assert.deepStrictEqual(yield* runs.revision(), changed);
        }).pipe(Effect.provide(fixture.open()));
      }).pipe(Effect.scoped),
    );
  });
};
