import { ItemNumber } from "@usine/core/item";
import { ProjectId } from "@usine/core/project";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { BoardLaneId, BoardTaskView } from "./board.ts";
import { ConfigurationView } from "./configuration/view.ts";
import { RunView } from "./run.ts";

export const repositoryPart = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+$/u, { message: "Expected a repository path segment" }),
);

export const changesRead = HttpApiEndpoint.get("changes", "/api/changes", {
  success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
})
  .annotate(OpenApi.Summary, "Subscribe to entity change notices")
  .annotate(
    OpenApi.Description,
    "Streams authorized entity identifiers and monotonic revisions. Resumes from Last-Event-ID or requests a cache reset.",
  );

export const workersRead = HttpApiEndpoint.get("workers", "/api/workers", {
  success: Schema.Struct({
    workers: ConfigurationView.fields.workers,
    removedWorkers: ConfigurationView.fields.removedWorkers,
  }),
})
  .annotate(OpenApi.Summary, "Read workers and slot usage")
  .annotate(OpenApi.Description, "Returns configured and removed workers with current slot usage.");

export const boardLaneItemsRead = HttpApiEndpoint.get(
  "boardLaneItems",
  "/api/projects/:project/lanes/:lane/items",
  {
    params: { project: ProjectId, lane: BoardLaneId },
    query: { offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) },
    success: Schema.Struct({
      items: Schema.Array(BoardTaskView),
      total: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
    }),
  },
)
  .annotate(OpenApi.Summary, "Read the next page of board cards")
  .annotate(OpenApi.Description, "Returns up to 50 items and the next offset for a project lane.");

export const taskRunsRead = HttpApiEndpoint.get(
  "taskRuns",
  "/api/projects/:owner/:repository/tasks/:item/runs",
  {
    params: {
      owner: repositoryPart,
      repository: repositoryPart,
      item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
    },
    query: { offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) },
    success: Schema.Struct({
      runs: Schema.Array(RunView),
      total: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
    }),
  },
)
  .annotate(OpenApi.Summary, "Read a page of task runs")
  .annotate(
    OpenApi.Description,
    "Returns up to 25 runs and the next offset for a repository task.",
  );
