import { ItemNumber } from "@usine/core/item";
import { ProjectId } from "@usine/core/project";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { BoardLaneId, BoardTaskView } from "./board.ts";
import { ConfigurationView } from "./configuration/view.ts";
import { RunSummaryView } from "./run.ts";

/** A query parameter that counts from 0. */
export const position = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const offset = position;

/** Returns an OpenAPI transform that gives the query parameters in `descriptions` their text. */
export const describeQuery =
  (descriptions: ReadonlyMap<string, string>): OpenApi.Transform["Service"] =>
  (operation) => ({
    ...operation,
    parameters: operation.parameters.map(
      (parameter: { readonly name: string; readonly in: string }) => {
        const description = descriptions.get(parameter.name);
        return parameter.in === "query" && description !== undefined
          ? { ...parameter, description }
          : parameter;
      },
    ),
  });

const describeOffset = describeQuery(
  new Map([["offset", "The position of the first entry to return. Defaults to 0."]]),
);

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
    query: { offset },
    success: Schema.Struct({
      items: Schema.Array(BoardTaskView),
      total: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
    }),
  },
)
  .annotate(OpenApi.Transform, describeOffset)
  .annotate(OpenApi.Summary, "Read a page of a lane's cards")
  .annotate(
    OpenApi.Description,
    "Returns the lane's cards from `offset`: up to 50, and no more than fit 20 KB of JSON. `total` counts the lane's cards, and `nextOffset` is the offset of the next page, or null after the last card.",
  );

export const taskRunsRead = HttpApiEndpoint.get(
  "taskRuns",
  "/api/projects/:owner/:repository/tasks/:item/runs",
  {
    params: {
      owner: repositoryPart,
      repository: repositoryPart,
      item: Schema.FiniteFromString.pipe(Schema.decodeTo(ItemNumber)),
    },
    query: { offset },
    success: Schema.Struct({
      runs: Schema.Array(RunSummaryView),
      total: Schema.Int,
      nextOffset: Schema.NullOr(Schema.Int),
    }),
  },
)
  .annotate(OpenApi.Transform, describeOffset)
  .annotate(OpenApi.Summary, "Read a page of task runs")
  .annotate(
    OpenApi.Description,
    "Returns the task's runs from `offset`, newest first: up to 25, and no more than fit 20 KB of JSON. A run here has no task prompt or result text; read them with the run's detail. `total` counts the task's runs, and `nextOffset` is the offset of the next page, or null after the last run.",
  );
