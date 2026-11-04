import { expect, it } from "@effect/vitest";
import { CycleLimit } from "@usine/core/cycle-budget";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { migrateProjectLoops, RepositoryProject } from "../../src/database/project-migration.ts";
import { Submission } from "../../src/engine/submission.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission, withRunStore } from "./support.ts";

it.effect(
  "preserves runs, deduplication, pause states, suppression, budgets, and attention across project migration",
  () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const sql = yield* SqlClient.SqlClient;
        const projects = ["one", "two"].map((name) =>
          RepositoryProject.make({
            repository: RepositoryName.make(`acme/${name}`),
            project: ProjectId.make(`acme-${name}`),
            loops: [
              LoopName.make(`acme-${name}/implement`),
              ...(name === "one" ? [LoopName.make("acme-one/review")] : []),
            ],
          }),
        );
        const submissions: Array<Submission> = [];
        for (const { repository } of projects) {
          const json1 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
            "implement",
            repository,
            1,
            "hash",
          ]).pipe(Effect.orDie);
          const key = json1;
          const json2 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
            "github",
            repository,
            1,
          ]).pipe(Effect.orDie);
          const submission = Submission.make({
            ...lifecycleSubmission,
            repository,
            loop: LoopName.make("implement"),
            approval: "required",
            cycleLimit: Option.some(CycleLimit.make(1)),
            itemKey: ItemKey.make(json2),
            event: Event.make({
              ...lifecycleSubmission.event,
              id: EventId.make(key),
              dedupKey: DedupKey.make(key),
            }),
          });
          submissions.push(submission);
          const runId = RunId.make(repository);
          yield* store.recordAndClaim(submission, runId);
          yield* sql`UPDATE usine_loop_items SET suppressed_by_run_id = ${runId}, suppressed_event_id = ${submission.event.id} WHERE item_key = ${submission.itemKey}`;
          const ask = {
            id: submission.event.id,
            repository,
            itemKey: submission.itemKey,
            loop: "implement",
            limit: 1,
            counts: [{ loop: "implement", admitted: 1, completed: 0 }],
          };
          const json3 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(ask).pipe(
            Effect.orDie,
          );
          yield* sql`UPDATE usine_item_cycle_budgets SET ask_json = ${json3} WHERE item_key = ${submission.itemKey}`;
          const need = {
            id: `cycle-budget:${submission.event.id}`,
            _tag: "CycleBudgetNeed",
            ask,
            itemLabel: "item",
            itemUrl: "url",
          };
          const json4 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            need,
          ).pipe(Effect.orDie);
          yield* sql`INSERT INTO usine_attention_acknowledgements (id, revision, dismissed_at) VALUES (${need.id}, ${json4}, '2026-10-29T00:00:00Z')`;
        }
        yield* sql`INSERT INTO usine_loop_runtime (loop_name, paused) VALUES ('implement', 1), ('review', 1)`;
        yield* migrateProjectLoops(projects).pipe(sql.withTransaction);
        yield* migrateProjectLoops(projects).pipe(sql.withTransaction);
        for (const submission of submissions) {
          const name = LoopName.make(`${submission.repository.replace("/", "-")}/implement`);
          const rows =
            yield* sql`SELECT loop_name FROM usine_runs WHERE run_id = ${submission.repository}`;
          expect(rows).toEqual([{ loop_name: name }]);
          const budgets =
            yield* sql`SELECT loop FROM usine_cycle_reservations WHERE run_id = ${submission.repository}`;
          expect(budgets).toEqual([{ loop: name }]);
          const suppressed =
            yield* sql`SELECT loop_name, suppressed_by_run_id FROM usine_loop_items WHERE item_key = ${submission.itemKey}`;
          expect(suppressed).toEqual([
            { loop_name: name, suppressed_by_run_id: submission.repository },
          ]);
          const asks =
            yield* sql`SELECT json_extract(ask_json, '$.loop') AS loop, json_extract(ask_json, '$.counts[0].loop') AS participant FROM usine_item_cycle_budgets WHERE item_key = ${submission.itemKey}`;
          expect(asks).toEqual([{ loop: name, participant: name }]);
          const json5 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
            name,
            submission.repository,
            1,
            "hash",
          ]).pipe(Effect.orDie);
          const dedupKey = DedupKey.make(json5);
          const repeated = yield* store.recordAndClaim(
            Submission.make({
              ...submission,
              loop: name,
              event: Event.make({ ...submission.event, id: EventId.make(dedupKey), dedupKey }),
            }),
            RunId.make("must-not-open"),
          );
          expect(repeated.result).toMatchObject({ _tag: "Claimed", runId: submission.repository });
        }
        const currentRows =
          yield* sql`SELECT loop_name, paused FROM usine_loop_runtime ORDER BY loop_name`;
        expect(currentRows).toEqual([
          { loop_name: "acme-one/implement", paused: 1 },
          { loop_name: "acme-one/review", paused: 1 },
          { loop_name: "acme-two/implement", paused: 1 },
        ]);
        const nextRows =
          yield* sql`SELECT json_extract(revision, '$.ask.loop') AS loop FROM usine_attention_acknowledgements ORDER BY loop`;
        expect(nextRows).toEqual([{ loop: "acme-one/implement" }, { loop: "acme-two/implement" }]);
      }),
    ),
);
