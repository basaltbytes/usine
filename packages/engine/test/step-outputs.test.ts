import { TestClock } from "effect/testing";
import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName, CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import {
  StepOutput,
  StepOutputName,
  StepOutputType,
  StepOutputSha256,
} from "@usine/core/step/output";
import { Effect, Layer, Option, Ref, Context } from "effect";
import { SqlClient } from "effect/sql";
import { memoryStepOutputLayer } from "../src/step-outputs/memory.ts";
import { sqliteStepOutputLayer } from "../src/step-outputs/sqlite.ts";
import { StepOutputContext, StepOutputStore } from "../src/step-outputs/store.ts";

const context = StepOutputContext.make({
  attemptId: AttemptId.make("attempt-1"),
  runId: RunId.make("run-1"),
  stepName: StepName.make("execute"),
  repository: RepositoryName.make("acme/demo"),
  itemNumber: Option.some(ItemNumber.make(42)),
});
const output = StepOutput.make({
  name: StepOutputName.make("walkthrough"),
  type: StepOutputType.make("balade.walkthrough"),
  commit: Option.some(CommitSha.make("a".repeat(40))),
  content: { sections: ["one", "two"] },
  size: 26,
  sha256: StepOutputSha256.make("b".repeat(64)),
});

const memory = Effect.gen(function* () {
  const succeeded = yield* Ref.make<ReadonlySet<AttemptId>>(new Set());
  const services = yield* Layer.build(
    memoryStepOutputLayer((id) => Ref.get(succeeded).pipe(Effect.map((ids) => ids.has(id)))),
  );
  return {
    store: Context.get(services, StepOutputStore),
    outcome: (attemptId: AttemptId, status: string) =>
      Ref.update(succeeded, (ids) =>
        status === "Succeeded"
          ? new Set([...ids, attemptId])
          : new Set([...ids].filter((id) => id !== attemptId)),
      ),
  };
});
const sqlite = Effect.gen(function* () {
  const services = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }));
  const sql = Context.get(services, SqlClient.SqlClient);
  yield* sql`CREATE TABLE usine_attempts (attempt_id TEXT PRIMARY KEY, outcome_json TEXT)`;
  const outputs = yield* Layer.build(
    sqliteStepOutputLayer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient)(sql))),
  );
  return {
    store: Context.get(outputs, StepOutputStore),
    outcome: (attemptId: AttemptId, status: string) =>
      sql`INSERT INTO usine_attempts (attempt_id, outcome_json) VALUES (${attemptId}, ${jsonKey({ _tag: status })}) ON CONFLICT(attempt_id) DO UPDATE SET outcome_json = excluded.outcome_json`.pipe(
        Effect.asVoid,
      ),
  };
});

for (const [name, fixture] of [
  ["memory", memory],
  ["sqlite", sqlite],
] as const) {
  describe(`StepOutputStore (${name})`, () => {
    it.effect("rewrites output keys once and exposes refs and bodies only after success", () =>
      Effect.gen(function* () {
        const { store, outcome } = yield* fixture;
        yield* store.write(context, [output]);
        for (const status of ["Running", "Failed", "Canceled", "AwaitingCi", "HandedOff"]) {
          yield* outcome(context.attemptId, status);
          const hiddenRefs = yield* store.list(
            context.repository,
            ItemNumber.make(42),
            Option.none(),
          );
          expect(hiddenRefs).toEqual([]);
          const hiddenBody = yield* store.read(context.attemptId, output.name);
          expect(hiddenBody).toEqual(Option.none());
        }
        yield* outcome(context.attemptId, "Succeeded");
        const original = yield* store.list(context.repository, ItemNumber.make(42), Option.none());
        yield* TestClock.adjust("1 second");
        yield* store.write(context, [output, output]);
        const rewritten = yield* store.list(
          RepositoryName.make("ACME/demo"),
          ItemNumber.make(42),
          Option.some(output.type),
        );
        expect(rewritten).toEqual(original);
        expect(original).toHaveLength(1);
        expect(original[0]).not.toHaveProperty("content");
        const body = yield* store.read(context.attemptId, output.name);
        expect(body).toEqual(Option.some(output));
        const otherItem = yield* store.list(context.repository, ItemNumber.make(43), Option.none());
        expect(otherItem).toEqual([]);
        const otherType = yield* store.list(
          context.repository,
          ItemNumber.make(42),
          Option.some(StepOutputType.make("other.type")),
        );
        expect(otherType).toEqual([]);
        const other = StepOutput.make({
          ...output,
          name: StepOutputName.make("second"),
          commit: Option.none(),
          type: StepOutputType.make("other.type"),
          content: [null, "multiline\ncontent"],
        });
        yield* store.write(context, [other]);
        const secondBody = yield* store.read(context.attemptId, other.name);
        expect(secondBody).toEqual(Option.some(other));
        const allRefs = yield* store.list(context.repository, ItemNumber.make(42), Option.none());
        expect(allRefs).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
}
